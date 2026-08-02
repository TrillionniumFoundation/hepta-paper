import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  runHeptaPaperReleaseAttestorClient,
} from '../bin/hepta-paper-release-attestor-client.mjs';
import {
  runHeptaPaperStateAuthorityClient,
} from '../bin/hepta-paper-state-authority-client.mjs';
import { HEPTA_PAPER_COMMAND_REGISTRY } from '../src/command-registry.mjs';

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const BIN_ROOT = path.join(WORKSPACE_ROOT, 'paper-core', 'bin');
const DEPLOY_ROOT = path.join(WORKSPACE_ROOT, 'paper-core', 'deploy');
const ENTRYPOINTS = Object.freeze([
  'codex-openclaw-managed',
  'hepta-paper-state-authority-client',
  'hepta-paper-release-attestor-client',
]);

function runNode(entrypoint, args = [], options = {}) {
  return spawnSync(process.execPath, [
    path.join(BIN_ROOT, `${entrypoint}.mjs`),
    ...args,
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 15_000,
    ...options,
  });
}

async function withAuthoritySocket(t, handle) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-authority-client-'));
  const socketPath = path.join(root, 'authority.sock');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
      socket.end(`${JSON.stringify({ ok: true, receipt: handle(request) })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  return socketPath;
}

test('managed Codex machine entrypoint has bounded help and strict configure parsing', () => {
  const help = runNode('codex-openclaw-managed', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: codex-openclaw-managed/);

  const configureHelp = runNode('codex-openclaw-managed', ['configure', '--help']);
  assert.equal(configureHelp.status, 0, configureHelp.stderr);
  assert.match(configureHelp.stdout, /--auth-profile-id/);
  assert.match(configureHelp.stdout, /--principal-role/);

  const execHelp = runNode('codex-openclaw-managed', ['exec', '--help']);
  assert.equal(execHelp.status, 0, execHelp.stderr);
  assert.match(execHelp.stdout, /--model/);

  const version = runNode('codex-openclaw-managed', ['--version'], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout,
    /^codex-openclaw-managed 3 bridge=[a-f0-9]{16} runtime=(?:[a-f0-9]{16}|unavailable)/);

  for (const [args, expected] of [
    [['configure', '--unknown'], /unknown_cli_option:--unknown/],
    [['configure', '--home'], /missing_cli_option_value:--home/],
    [['configure', '--force', '--force'], /duplicate_cli_option:--force/],
    [['not-a-command'], /codex_openclaw_managed_command_invalid/],
  ]) {
    const result = runNode('codex-openclaw-managed', args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, expected, args.join(' '));
  }
});

test('state-authority client keeps a no-argument pinned socket contract', async (t) => {
  const help = runNode('hepta-paper-state-authority-client', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /request\.json/);

  const unknown = runNode('hepta-paper-state-authority-client', ['--socket', '/tmp/x']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown_cli_option:--socket/);

  await assert.rejects(
    runHeptaPaperStateAuthorityClient({ input: 'not-json' }),
    /local_state_authority_client_request_invalid/,
  );

  const socketPath = await withAuthoritySocket(t, (request) => ({
    version: 1,
    kind: 'StateAuthorityClientFixtureReceipt',
    requestId: request.requestId,
  }));
  const receipt = await runHeptaPaperStateAuthorityClient({
    input: JSON.stringify({ requestId: 'fixture-request' }),
    socketPath,
  });
  assert.deepEqual(receipt, {
    version: 1,
    kind: 'StateAuthorityClientFixtureReceipt',
    requestId: 'fixture-request',
  });
});

test('release-attestor client returns help before stdin and rejects ambiguous sockets', async () => {
  const help = runNode('hepta-paper-release-attestor-client', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--socket PATH/);

  for (const [args, input, expected] of [
    [[], '{}', /local_release_attestor_socket_required/],
    [['--socket', 'relative.sock'], '{}', /local_release_attestor_socket_invalid/],
    [['--socket', '/tmp/hepta-missing.sock'], 'not-json',
      /local_release_attestor_client_request_invalid/],
    [['--unknown'], '{}', /unknown_cli_option:--unknown/],
  ]) {
    const result = runNode('hepta-paper-release-attestor-client', args, { input });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, expected, args.join(' '));
  }

  await assert.rejects(
    runHeptaPaperReleaseAttestorClient({
      argv: ['--socket', 'relative.sock'],
      input: '{}',
    }),
    /local_release_attestor_socket_invalid/,
  );
});

test('host deployment materializes fixed absolute launchers without operator routes', () => {
  const installer = fs.readFileSync(
    path.join(DEPLOY_ROOT, 'install-hepta-paper-systemd-host.sh'),
    'utf8',
  );
  const routedEntrypoints = new Set(
    Object.values(HEPTA_PAPER_COMMAND_REGISTRY)
      .flatMap((group) => Object.values(group))
      .flatMap((route) => route.argv || [])
      .filter((value) => typeof value === 'string'),
  );

  for (const name of ENTRYPOINTS) {
    const sourcePath = path.join(BIN_ROOT, `${name}.mjs`);
    assert.equal(fs.statSync(sourcePath).mode & 0o111, 0, sourcePath);
    const launcherPath = path.join(DEPLOY_ROOT, name);
    assert.equal(fs.statSync(launcherPath).mode & 0o111, 0, launcherPath);
    const launcher = fs.readFileSync(launcherPath, 'utf8');
    assert.equal(spawnSync('sh', ['-n', launcherPath]).status, 0, name);
    assert.equal(launcher, [
      '#!/bin/sh',
      'set -eu',
      '',
      'exec /usr/bin/node \\',
      `  /opt/hepta-paper/paper-core/bin/${name}.mjs "$@"`,
      '',
    ].join('\n'));
    assert.doesNotMatch(launcher, /\beval\b|\$\{?PATH/);
    assert.match(installer,
      /"\$snapshot_root\/\$launcher" "\$\(target \/usr\/libexec\/hepta-paper\/\$launcher\)"/);
    assert.equal(routedEntrypoints.has(`paper-core/bin/${name}.mjs`), false, name);
  }
  assert.match(installer, /\/usr\/bin\/install \$owner_arguments -m 0755/);
  assert.match(installer, /owner_arguments="-o root -g root"/);
});
