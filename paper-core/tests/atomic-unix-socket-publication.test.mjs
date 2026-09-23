import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  requestLocalReleaseAttestor,
} from '../../paper-adapters/build-package/local-release-attestor-socket.mjs';
import {
  requestLocalAutonomousResearchStateAuthority,
  startLocalAutonomousResearchStateAuthorityServer,
} from '../../paper-adapters/automation/local-autonomous-research-state-authority-socket.mjs';
import {
  listenOnAtomicUnixSocket,
} from '../../paper-adapters/runtime/atomic-unix-socket-publication.mjs';

const RELEASE_SOCKET_MODULE = new URL(
  '../../paper-adapters/build-package/local-release-attestor-socket.mjs',
  import.meta.url,
).href;
const AUTHORITY_SOCKET_MODULE = new URL(
  '../../paper-adapters/automation/local-autonomous-research-state-authority-socket.mjs',
  import.meta.url,
).href;

const CHILD_SOURCE = `
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const kind = process.argv[1];
  const moduleUrl = process.argv[2];
  const socketPath = process.argv[3];
  const fault = process.argv[4];
  const gatePath = process.argv[5];
  process.umask(0);
  const originalChmodSync = fs.chmodSync;
  const originalLinkSync = fs.linkSync;
  let barrierSent = false;
  fs.chmodSync = function chmodSyncWithBarrier(candidate, mode, ...rest) {
    let socket = false;
    try { socket = fs.lstatSync(candidate).isSocket(); } catch {}
    if (!socket && fault === 'staging-chmod' && String(candidate).includes('/.s-')) {
      process.stdout.write('staging-chmod-barrier\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      throw new Error('injected_staging_chmod_failure');
    }
    if (socket && !barrierSent) {
      barrierSent = true;
      process.stdout.write('chmod-barrier\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      if (fault === 'chmod') throw new Error('injected_socket_chmod_failure');
    }
    return originalChmodSync.call(this, candidate, mode, ...rest);
  };
  fs.linkSync = function linkSyncWithFault(source, target, ...rest) {
    if (target !== socketPath
      || !['link-wait', 'link-failure', 'post-link'].includes(fault)) {
      return originalLinkSync.call(this, source, target, ...rest);
    }
    const marker = socketPath + '.' + process.pid + '.link-ready';
    fs.writeFileSync(marker, 'ready', { mode: 0o600 });
    process.stdout.write('link-barrier\\n');
    try {
      if (fault === 'link-wait') {
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(gatePath)) Atomics.wait(wait, 0, 0, 5);
      } else {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      }
      if (fault === 'link-failure') throw new Error('injected_socket_link_failure');
      const result = originalLinkSync.call(this, source, target, ...rest);
      if (fault === 'post-link') throw new Error('injected_post_link_failure');
      return result;
    } finally {
      try { fs.unlinkSync(marker); } catch {}
    }
  };
  syncBuiltinESMExports();
  const api = await import(moduleUrl);
  let listener;
  try {
    listener = kind === 'release'
      ? await api.startLocalReleaseAttestorServer({
          socketPath,
          handleRequest: (request) => ({ ok: true, request }),
        })
      : await api.startLocalAutonomousResearchStateAuthorityServer({
          socketPath,
          maximumMessageBytes: 4096,
          authority: Object.freeze({
            handle: (request) => Object.freeze({
              version: 1,
              kind: 'AtomicSocketChildReceipt',
              requestId: request.requestId,
            }),
          }),
        });
  } catch (error) {
    process.stderr.write(String(error?.message || error) + '\\n');
    process.exitCode = 23;
  }
  if (listener) {
    process.stdout.write('ready\\n');
    await new Promise((resolve) => process.once('SIGTERM', resolve));
    await listener.close();
    process.stdout.write('closed\\n');
  }
`;

const STALE_SOCKET_CHILD_SOURCE = `
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(process.argv[1], resolve);
  });
  process.stdout.write('ready\\n');
  await new Promise(() => {});
`;

function capturedChild(arguments_) {
  const child = spawn(process.execPath, arguments_, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return Object.freeze({
    child,
    exit: once(child, 'exit'),
    stdout: () => stdout,
    stderr: () => stderr,
  });
}

async function waitForOutput(runtime, expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime.stdout().includes(expected)) return;
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) break;
    await delay(10);
  }
  throw new Error(`child output timeout: ${JSON.stringify({
    expected,
    stdout: runtime.stdout(),
    stderr: runtime.stderr(),
    exitCode: runtime.child.exitCode,
    signalCode: runtime.child.signalCode,
  })}`);
}

function assertPrivateStagingSocket(root) {
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  assert.equal(directories.length, 1);
  const stagingRoot = path.join(root, directories[0].name);
  assert.equal(fs.lstatSync(stagingRoot).mode & 0o777, 0o700);
  const sockets = fs.readdirSync(stagingRoot)
    .map((name) => path.join(stagingRoot, name))
    .filter((candidate) => fs.lstatSync(candidate).isSocket());
  assert.equal(sockets.length, 1);
  assert.equal(fs.lstatSync(sockets[0]).mode & 0o777, 0o777);
}

async function requestChild(kind, socketPath) {
  if (kind === 'release') {
    const response = await requestLocalReleaseAttestor({
      socketPath,
      request: Object.freeze({ requestId: 'release' }),
    });
    assert.equal(response.ok, true);
    assert.equal(response.request.requestId, 'release');
    return;
  }
  const receipt = await requestLocalAutonomousResearchStateAuthority({
    socketPath,
    request: Object.freeze({ requestId: 'authority' }),
    maximumMessageBytes: 4096,
  });
  assert.equal(receipt.kind, 'AtomicSocketChildReceipt');
  assert.equal(receipt.requestId, 'authority');
}

test('Unix sockets remain private until chmod and publish atomically at mode 0660', {
  skip: process.platform !== 'linux',
}, async (t) => {
  for (const [kind, moduleUrl] of [
    ['release', RELEASE_SOCKET_MODULE],
    ['authority', AUTHORITY_SOCKET_MODULE],
  ]) {
    await t.test(kind, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-atomic-${kind}-`));
      const socketPath = path.join(root, `${kind}.sock`);
      const runtime = capturedChild([
        '--input-type=module', '--eval', CHILD_SOURCE,
        kind, moduleUrl, socketPath, 'none',
      ]);
      try {
        await waitForOutput(runtime, 'chmod-barrier\n');
        assert.equal(fs.existsSync(socketPath), false);
        assertPrivateStagingSocket(root);
        await waitForOutput(runtime, 'ready\n');
        const published = fs.lstatSync(socketPath);
        assert.equal(published.isSocket(), true);
        assert.equal(published.mode & 0o777, 0o660);
        assert.deepEqual(
          fs.readdirSync(root).sort(),
          [`${kind}.sock`],
        );
        await requestChild(kind, socketPath);
        assert.equal(runtime.child.kill('SIGTERM'), true);
        const [code, signal] = await runtime.exit;
        assert.equal(code, 0, runtime.stderr());
        assert.equal(signal, null);
        assert.equal(fs.existsSync(socketPath), false);
      } finally {
        if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
          runtime.child.kill('SIGKILL');
          await runtime.exit;
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('socket chmod failure closes the staged listener and leaves no pathname', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-atomic-chmod-failure-'));
  const socketPath = path.join(root, 'authority.sock');
  const runtime = capturedChild([
    '--input-type=module', '--eval', CHILD_SOURCE,
    'authority', AUTHORITY_SOCKET_MODULE, socketPath, 'chmod',
  ]);
  try {
    await waitForOutput(runtime, 'chmod-barrier\n');
    assert.equal(fs.existsSync(socketPath), false);
    const [code, signal] = await runtime.exit;
    assert.equal(code, 23, runtime.stderr());
    assert.equal(signal, null);
    assert.match(runtime.stderr(), /injected_socket_chmod_failure|socket/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      runtime.child.kill('SIGKILL');
      await runtime.exit;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staging chmod failure removes the provisionally identified directory', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-atomic-staging-failure-'));
  const socketPath = path.join(root, 'authority.sock');
  const runtime = capturedChild([
    '--input-type=module', '--eval', CHILD_SOURCE,
    'authority', AUTHORITY_SOCKET_MODULE, socketPath, 'staging-chmod',
  ]);
  try {
    await waitForOutput(runtime, 'staging-chmod-barrier\n');
    assert.equal(fs.existsSync(socketPath), false);
    const [code, signal] = await runtime.exit;
    assert.equal(code, 23, runtime.stderr());
    assert.equal(signal, null);
    assert.equal(
      runtime.stderr(),
      'local_state_authority_socket_publication_failed\n',
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      runtime.child.kill('SIGKILL');
      await runtime.exit;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('link failures preserve exact caller errors and roll back all pathnames', {
  skip: process.platform !== 'linux',
}, async (t) => {
  for (const [kind, moduleUrl, fault, expectedError] of [
    ['release', RELEASE_SOCKET_MODULE, 'link-failure', 'local_release_attestor_socket_invalid'],
    [
      'authority',
      AUTHORITY_SOCKET_MODULE,
      'post-link',
      'local_state_authority_socket_publication_failed',
    ],
  ]) {
    await t.test(`${kind}:${fault}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-atomic-${fault}-`));
      const socketPath = path.join(root, `${kind}.sock`);
      const runtime = capturedChild([
        '--input-type=module', '--eval', CHILD_SOURCE,
        kind, moduleUrl, socketPath, fault,
      ]);
      try {
        await waitForOutput(runtime, 'link-barrier\n');
        assert.equal(fs.existsSync(socketPath), false);
        const [code, signal] = await runtime.exit;
        assert.equal(code, 23, runtime.stderr());
        assert.equal(signal, null);
        assert.equal(runtime.stderr(), `${expectedError}\n`);
        assert.deepEqual(fs.readdirSync(root), []);
      } finally {
        if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
          runtime.child.kill('SIGKILL');
          await runtime.exit;
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

function testAuthority() {
  return Object.freeze({
    handle(request) {
      return Object.freeze({
        version: 1,
        kind: 'AtomicSocketTestReceipt',
        requestId: request.requestId,
      });
    },
  });
}

test('active socket publication is no-clobber and the winner remains available', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-atomic-no-clobber-'));
  const socketPath = path.join(root, 'authority.sock');
  const primary = await startLocalAutonomousResearchStateAuthorityServer({
    authority: testAuthority(),
    socketPath,
    maximumMessageBytes: 4096,
  });
  try {
    assert.equal(primary.socketPath, socketPath);
    await assert.rejects(
      startLocalAutonomousResearchStateAuthorityServer({
        authority: testAuthority(),
        socketPath,
        maximumMessageBytes: 4096,
      }),
      /socket/,
    );
    const receipt = await requestLocalAutonomousResearchStateAuthority({
      socketPath,
      request: Object.freeze({ requestId: 'winner' }),
      maximumMessageBytes: 4096,
    });
    assert.equal(receipt.requestId, 'winner');
    assert.deepEqual(fs.readdirSync(root), ['authority.sock']);
  } finally {
    const firstClose = primary.close();
    assert.strictEqual(primary.close(), firstClose);
    await firstClose;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed publisher configurations and non-socket occupants fail closed', {
  skip: process.platform !== 'linux',
}, async () => {
  const server = Object.freeze({
    listen() {}, close() {}, once() {}, off() {},
  });
  const absoluteSocket = path.join(os.tmpdir(), 'hepta-atomic-invalid.sock');
  for (const configuration of [
    {},
    { server: {}, socketPath: absoluteSocket, socketMode: 0o660 },
    { server: { listen() {} }, socketPath: absoluteSocket, socketMode: 0o660 },
    {
      server: { listen() {}, close() {} },
      socketPath: absoluteSocket,
      socketMode: 0o660,
    },
    {
      server: { listen() {}, close() {}, once() {} },
      socketPath: absoluteSocket,
      socketMode: 0o660,
    },
    { server, socketPath: 42, socketMode: 0o660 },
    { server, socketPath: 'relative.sock', socketMode: 0o660 },
    { server, socketPath: `${absoluteSocket}\0suffix`, socketMode: 0o660 },
    { server, socketPath: absoluteSocket, socketMode: Number.NaN },
    { server, socketPath: absoluteSocket, socketMode: -1 },
    { server, socketPath: absoluteSocket, socketMode: 0o1000 },
  ]) {
    await assert.rejects(
      listenOnAtomicUnixSocket(configuration),
      { message: 'atomic_unix_socket_configuration_invalid' },
    );
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-atomic-occupied-'));
  const socketPath = path.join(root, 'authority.sock');
  fs.writeFileSync(socketPath, 'preserve', { mode: 0o600 });
  try {
    await assert.rejects(
      startLocalAutonomousResearchStateAuthorityServer({
        authority: testAuthority(),
        socketPath,
        maximumMessageBytes: 4096,
      }),
      { message: 'local_state_authority_socket_path_conflict' },
    );
    assert.equal(fs.readFileSync(socketPath, 'utf8'), 'preserve');
    assert.deepEqual(fs.readdirSync(root), ['authority.sock']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listener startup failure rolls back the private staging directory', {
  skip: process.platform !== 'linux',
}, async () => {
  class FailingServer extends EventEmitter {
    listening = false;

    listen() {
      queueMicrotask(() => this.emit('error', new Error('injected_listen_failure')));
    }

    close(callback) { callback(); }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-atomic-listen-failure-'));
  try {
    await assert.rejects(
      listenOnAtomicUnixSocket({
        server: new FailingServer(),
        socketPath: path.join(root, 'authority.sock'),
        socketMode: 0o660,
      }),
      { message: 'atomic_unix_socket_publication_failed' },
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('simultaneous atomic publication has exactly one no-clobber winner', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-atomic-concurrent-'));
  const socketPath = path.join(root, 'authority.sock');
  const gatePath = path.join(root, 'publish.gate');
  const runtimes = [0, 1].map(() => capturedChild([
    '--input-type=module', '--eval', CHILD_SOURCE,
    'authority', AUTHORITY_SOCKET_MODULE, socketPath, 'link-wait', gatePath,
  ]));
  try {
    await Promise.all(runtimes.map((runtime) => waitForOutput(runtime, 'link-barrier\n')));
    assert.equal(fs.existsSync(socketPath), false);
    fs.writeFileSync(gatePath, 'publish', { mode: 0o600 });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && runtimes.some((runtime) => (
      !runtime.stdout().includes('ready\n')
        && runtime.child.exitCode === null
        && runtime.child.signalCode === null
    ))) await delay(10);
    const winners = runtimes.filter((runtime) => runtime.stdout().includes('ready\n'));
    const losers = runtimes.filter((runtime) => !runtime.stdout().includes('ready\n'));
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const [loserCode, loserSignal] = await losers[0].exit;
    assert.equal(loserCode, 23, losers[0].stderr());
    assert.equal(loserSignal, null);
    assert.equal(
      losers[0].stderr(),
      'local_state_authority_socket_path_conflict\n',
    );
    fs.unlinkSync(gatePath);
    const receipt = await requestLocalAutonomousResearchStateAuthority({
      socketPath,
      request: Object.freeze({ requestId: 'concurrent-winner' }),
      maximumMessageBytes: 4096,
    });
    assert.equal(receipt.requestId, 'concurrent-winner');
    assert.deepEqual(fs.readdirSync(root), ['authority.sock']);
    assert.equal(winners[0].child.kill('SIGTERM'), true);
    const [winnerCode, winnerSignal] = await winners[0].exit;
    assert.equal(winnerCode, 0, winners[0].stderr());
    assert.equal(winnerSignal, null);
  } finally {
    for (const runtime of runtimes) {
      if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
        runtime.child.kill('SIGKILL');
        await runtime.exit;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsafe and symlinked parent directories fail closed', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-atomic-parent-'));
  const unsafeParent = path.join(root, 'unsafe');
  const safeParent = path.join(root, 'safe');
  const symlinkParent = path.join(root, 'symlink');
  const unsafeAncestor = path.join(root, 'unsafe-ancestor');
  const nestedSafeParent = path.join(unsafeAncestor, 'safe');
  fs.mkdirSync(unsafeParent, { mode: 0o755 });
  fs.chmodSync(unsafeParent, 0o755);
  fs.mkdirSync(safeParent, { mode: 0o700 });
  fs.symlinkSync(safeParent, symlinkParent);
  fs.mkdirSync(unsafeAncestor, { mode: 0o770 });
  fs.chmodSync(unsafeAncestor, 0o770);
  fs.mkdirSync(nestedSafeParent, { mode: 0o700 });
  try {
    for (const parent of [unsafeParent, symlinkParent, nestedSafeParent]) {
      await assert.rejects(
        startLocalAutonomousResearchStateAuthorityServer({
          authority: testAuthority(),
          socketPath: path.join(parent, 'authority.sock'),
          maximumMessageBytes: 4096,
        }),
        { message: 'local_state_authority_socket_publication_failed' },
      );
    }
    assert.deepEqual(fs.readdirSync(unsafeParent), []);
    assert.deepEqual(fs.readdirSync(safeParent), []);
    assert.deepEqual(fs.readdirSync(nestedSafeParent), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale sockets recover but close never unlinks a replacement inode', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-atomic-stale-'));
  const socketPath = path.join(root, 'authority.sock');
  const stale = capturedChild([
    '--input-type=module', '--eval', STALE_SOCKET_CHILD_SOURCE, socketPath,
  ]);
  let listener;
  try {
    await waitForOutput(stale, 'ready\n');
    assert.equal(stale.child.kill('SIGKILL'), true);
    await stale.exit;
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
    listener = await startLocalAutonomousResearchStateAuthorityServer({
      authority: testAuthority(),
      socketPath,
      maximumMessageBytes: 4096,
    });
    const receipt = await requestLocalAutonomousResearchStateAuthority({
      socketPath,
      request: Object.freeze({ requestId: 'recovered' }),
      maximumMessageBytes: 4096,
    });
    assert.equal(receipt.requestId, 'recovered');
    fs.unlinkSync(socketPath);
    fs.writeFileSync(socketPath, 'replacement', { mode: 0o600 });
    await assert.rejects(listener.close(), /cleanup_identity_mismatch/);
    listener = null;
    assert.equal(fs.readFileSync(socketPath, 'utf8'), 'replacement');
  } finally {
    if (listener) await listener.close();
    if (stale.child.exitCode === null && stale.child.signalCode === null) {
      stale.child.kill('SIGKILL');
      await stale.exit;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('raw state-authority server close still removes the published socket', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-atomic-raw-close-'));
  const socketPath = path.join(root, 'authority.sock');
  const listener = await startLocalAutonomousResearchStateAuthorityServer({
    authority: testAuthority(),
    socketPath,
    maximumMessageBytes: 4096,
  });
  try {
    await new Promise((resolve, reject) => {
      listener.server.close((error) => error ? reject(error) : resolve());
    });
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
