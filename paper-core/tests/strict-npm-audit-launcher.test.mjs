import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStrictNpmAuditInvocation,
  runStrictNpmAudit,
} from '../../paper-adapters/runtime/strict-npm-audit-launcher.mjs';
import { runStrictNpmAuditCli } from '../bin/strict-npm-audit.mjs';
import { runProductionStrictNpmAudit } from '../../paper-composition/bootstrap/strict-npm-audit-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function inspected(file) {
  return Object.freeze({
    path: file,
    uid: 0,
    gid: 0,
    mode: 0o755,
    contentHash: hashRecord('StrictNpmAuditTestExecutable', file),
  });
}

test('launcher pins Node network flags, official registry, strict TLS and audit policy', () => {
  const root = fs.realpathSync(process.cwd());
  const invocation = buildStrictNpmAuditInvocation({
    workspaceRoot: root,
    npmExecPath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
    nodeExecPath: '/usr/bin/node',
    executableInspector: inspected,
  });
  assert.equal(invocation.command, '/usr/bin/node');
  assert.deepEqual(invocation.argv, [
    '--dns-result-order=ipv4first',
    '--no-network-family-autoselection',
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    'audit',
    '--registry=https://registry.npmjs.org/',
    '--strict-ssl=true',
    '--audit-level=high',
    '--package-lock-only',
    '--ignore-scripts',
  ]);
});

test('clean invocation uses private ephemeral HOME/cache and removes both after npm', () => {
  const root = fs.realpathSync(process.cwd());
  let captured;
  let temporaryRoot;
  const result = runStrictNpmAudit({
    workspaceRoot: root,
    npmExecPath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
    nodeExecPath: '/usr/bin/node',
    executableInspector: inspected,
    environment: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
    spawn(command, argv, options) {
      captured = { command, argv, options };
      assert.equal(fs.statSync(options.env.HOME).mode & 0o7777, 0o700);
      assert.equal(fs.statSync(options.env.npm_config_cache).mode & 0o7777, 0o700);
      assert.equal(path.dirname(options.env.HOME), path.dirname(options.env.npm_config_cache));
      temporaryRoot = path.dirname(options.env.HOME);
      return { status: 0, signal: null, stdout: 'found 0 vulnerabilities\n', stderr: '' };
    },
  });
  assert.equal(result.status, 'strict_npm_audit_verified');
  assert.equal(captured.options.shell, false);
  for (const name of [
    'NODE_OPTIONS', 'HTTPS_PROXY', 'npm_config_registry', 'SSL_CERT_FILE', 'NO_PROXY',
  ]) assert.equal(Object.hasOwn(captured.options.env, name), false, name);
  assert.deepEqual(Object.keys(captured.options.env).sort(),
    ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'npm_config_cache']);
  assert.equal(fs.existsSync(temporaryRoot), false);
});

test('empty inherited pollution values are accepted and stripped from the child', () => {
  const root = fs.realpathSync(process.cwd());
  let childEnvironment;
  runStrictNpmAudit({
    workspaceRoot: root,
    npmExecPath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
    nodeExecPath: '/usr/bin/node',
    executableInspector: inspected,
    environment: {
      npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      npm_config_noproxy: '',
      NODE_OPTIONS: '',
      HTTPS_PROXY: '',
    },
    spawn(command, argv, options) {
      childEnvironment = options.env;
      return { status: 0, signal: null, stdout: '', stderr: '' };
    },
  });
  assert.equal(Object.hasOwn(childEnvironment, 'npm_config_noproxy'), false);
  assert.equal(Object.hasOwn(childEnvironment, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(childEnvironment, 'HTTPS_PROXY'), false);
});

test('the exact host IPv4 preference is accepted but never inherited by npm', () => {
  const root = fs.realpathSync(process.cwd());
  let childEnvironment;
  runStrictNpmAudit({
    workspaceRoot: root,
    npmExecPath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
    nodeExecPath: '/usr/bin/node',
    executableInspector: inspected,
    environment: {
      npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      npm_config_noproxy: '',
    },
    spawn(command, argv, options) {
      childEnvironment = options.env;
      return { status: 0, signal: null, stdout: '', stderr: '' };
    },
  });
  assert.equal(Object.hasOwn(childEnvironment, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(childEnvironment, 'npm_config_noproxy'), false);
});

test('ambient Node, TLS, registry and proxy pollution is rejected before spawn', () => {
  const root = fs.realpathSync(process.cwd());
  for (const [name, value] of [
    ['NODE_OPTIONS', '--import=/tmp/poison.mjs'],
    ['HTTPS_PROXY', 'https://attacker.invalid'],
    ['npm_config_registry', 'https://attacker.invalid'],
    ['SSL_CERT_FILE', '/tmp/attacker-ca.pem'],
  ]) {
    let spawned = false;
    assert.throws(() => runStrictNpmAudit({
      workspaceRoot: root,
      npmExecPath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      nodeExecPath: '/usr/bin/node',
      executableInspector: inspected,
      environment: {
        npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
        [name]: value,
      },
      spawn() { spawned = true; },
    }), new RegExp(`strict_npm_audit_inherited_environment_forbidden:${name}`, 'u'));
    assert.equal(spawned, false);
  }
});

test('npm_execpath is required and executable paths are exact-allowlisted', () => {
  assert.throws(() => runStrictNpmAudit({
    workspaceRoot: process.cwd(),
    environment: {},
    npmExecPath: null,
  }), /strict_npm_audit_npm_execpath_required/u);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-npm-audit-'));
  const real = path.join(root, 'npm-cli.js.real');
  const link = path.join(root, 'npm-cli.js');
  fs.writeFileSync(real, 'process.exit(0);\n');
  fs.symlinkSync(real, link);
  assert.throws(() => buildStrictNpmAuditInvocation({
    workspaceRoot: root,
    npmExecPath: link,
    nodeExecPath: link,
    expectedExecutableUid: process.getuid(),
    expectedExecutableGid: process.getgid(),
  }), /strict_npm_audit_executable_not_approved/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test('production audit composition preserves injected launcher authority', () => {
  const root = fs.realpathSync(process.cwd());
  let spawned = false;
  const result = runProductionStrictNpmAudit({
    workspaceRoot: root,
    npmExecPath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
    nodeExecPath: '/usr/bin/node',
    executableInspector: inspected,
    environment: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
    spawn() {
      spawned = true;
      return { status: 0, signal: null, stdout: 'found 0 vulnerabilities\n', stderr: '' };
    },
  });
  assert.equal(spawned, true);
  assert.equal(result.status, 'strict_npm_audit_verified');
});

test('strict npm audit CLI wrapper covers usage, success, and typed failure paths', () => {
  const stream = () => {
    let value = '';
    return {
      write(chunk) { value += String(chunk); },
      get value() { return value; },
    };
  };
  const usageOut = stream();
  assert.equal(runStrictNpmAuditCli({
    argv: ['--unexpected'],
    stdout: usageOut,
    stderr: usageOut,
    run() { assert.fail('usage must not invoke runner'); },
  }), 64);
  assert.match(usageOut.value, /Usage: strict-npm-audit/u);

  const successOut = stream();
  assert.equal(runStrictNpmAuditCli({
    argv: [],
    stdout: successOut,
    stderr: successOut,
    run: () => ({ stdout: 'audit stdout\n', stderr: 'audit stderr\n' }),
  }), 0);
  assert.match(successOut.value, /audit stdout\n.*audit stderr/su);

  const failureOut = stream();
  assert.equal(runStrictNpmAuditCli({
    argv: [],
    stdout: failureOut,
    stderr: failureOut,
    run() {
      const error = new Error('audit failed');
      error.code = 'strict_npm_audit_failed';
      error.exitStatus = 17;
      error.stdout = 'partial stdout\n';
      error.stderr = 'partial stderr\n';
      throw error;
    },
  }), 17);
  assert.match(failureOut.value, /partial stdout\n.*partial stderr\n.*strict_npm_audit_failed/su);
});

test('strict npm audit bin rejects extra arguments before invoking npm', () => {
  const bin = fileURLToPath(new URL('../bin/strict-npm-audit.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [bin, '--unexpected'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /Usage: strict-npm-audit/u);
});
