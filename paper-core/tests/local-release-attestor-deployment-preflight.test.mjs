import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  provisionLocalReleaseAttestorDeploymentFixture,
} from './support/local-release-attestor-deployment-fixture.mjs';

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const DEPLOY_ROOT = path.join(WORKSPACE_ROOT, 'paper-core', 'deploy');
const DAEMON = path.join(
  WORKSPACE_ROOT,
  'paper-core',
  'bin',
  'hepta-paper-release-attestor-daemon.mjs',
);
const INSTALLER = path.join(
  DEPLOY_ROOT,
  'install-hepta-paper-systemd-host.sh',
);

function fixtureRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runPreflight(value) {
  const uid = String(process.getuid());
  return spawnSync(process.execPath, [
    DAEMON,
    '--preflight-configuration-pair',
    '--signer-configuration',
    value.signerConfigurationPath,
    '--probe-configuration',
    value.probeConfigurationPath,
    '--signer-private-key-owner-uid',
    uid,
    '--probe-private-key-owner-uid',
    uid,
  ], { cwd: WORKSPACE_ROOT, encoding: 'utf8' });
}

function runInstaller(root, extraArguments = []) {
  return spawnSync(INSTALLER, [
    '--root', root, '--no-systemctl', ...extraArguments,
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function contentSnapshot(root) {
  const entries = [];
  const visit = (candidate) => {
    const stat = fs.lstatSync(candidate);
    const relative = path.relative(root, candidate) || '.';
    if (stat.isDirectory()) {
      entries.push([relative, 'directory', stat.mode & 0o7777]);
      for (const name of fs.readdirSync(candidate).sort()) {
        visit(path.join(candidate, name));
      }
      return;
    }
    assert.equal(stat.isFile(), true, relative);
    entries.push([
      relative,
      'file',
      stat.mode & 0o7777,
      fs.readFileSync(candidate).toString('base64'),
    ]);
  };
  visit(root);
  return entries;
}

test('v2 schema and examples expose the exact bounded dedicated-UID profile', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(
    DEPLOY_ROOT,
    'local-release-attestor-daemon.schema.json',
  ), 'utf8'));
  const signer = JSON.parse(fs.readFileSync(path.join(
    DEPLOY_ROOT,
    'local-release-attestor-signer.config.example.json',
  ), 'utf8'));
  const probe = JSON.parse(fs.readFileSync(path.join(
    DEPLOY_ROOT,
    'local-release-attestor-probe.config.example.json',
  ), 'utf8'));
  assert.equal(schema.$defs.baseProperties.version.const, 2);
  assert.equal(schema.$defs.signer.additionalProperties, false);
  assert.equal(schema.$defs.probe.additionalProperties, false);
  assert.equal(schema.$defs.socketPolicy.additionalProperties, false);
  assert.deepEqual(signer.socketPolicy, {
    idleTimeoutMs: 5_000,
    requestDeadlineMs: 10_000,
    maximumConcurrentConnections: 32,
  });
  assert.deepEqual(probe.socketPolicy, signer.socketPolicy);
  assert.equal(signer.version, 2);
  assert.equal(probe.version, 2);
  assert.equal(probe.signerSocketPath, signer.socketPath);
  for (const source of [JSON.stringify(signer), JSON.stringify(probe)]) {
    assert.doesNotMatch(source, /BEGIN (?:OPENSSH|PRIVATE) KEY/);
  }
});

test('candidate pair preflight accepts only coherent v2 configurations', (t) => {
  const root = fixtureRoot(t, 'hepta-attestor-preflight-');
  const value = provisionLocalReleaseAttestorDeploymentFixture(root);
  const ready = runPreflight(value);
  assert.equal(ready.status, 0, ready.stderr);
  const receipt = JSON.parse(ready.stdout);
  assert.equal(receipt.version, 2);
  assert.equal(
    receipt.status,
    'local_release_attestor_deployment_configuration_preflight_passed',
  );
  assert.match(
    receipt.localReleaseAttestorDeploymentConfigurationPreflightReceiptHash,
    /^sha256:[0-9a-f]{64}$/,
  );

  const rejected = [
    ['legacy-v1', { ...value.signer, version: 1 }, value.probe,
      /local_release_attestor_configuration_v2_required/],
    ['unknown-field', { ...value.signer, unexpected: true }, value.probe,
      /local_release_attestor_configuration_invalid/],
    ['unknown-policy-field', {
      ...value.signer,
      socketPolicy: { ...value.signer.socketPolicy, unexpected: 1 },
    }, value.probe, /local_release_attestor_socket_policy_invalid/],
    ['out-of-range', {
      ...value.signer,
      socketPolicy: { ...value.signer.socketPolicy, idleTimeoutMs: 999 },
    }, value.probe, /local_release_attestor_socket_policy_invalid/],
    ['pair-mismatch', value.signer, {
      ...value.probe,
      signerKeyVersion: 'different-v2',
    }, /local_release_attestor_configuration_pair_invalid/],
  ];
  for (const [name, signer, probe, error] of rejected) {
    value.writeConfigurations({ selectedSigner: signer, selectedProbe: probe });
    const result = runPreflight(value);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, error, name);
  }
});

test('actual installer rejects v1, unknown, and out-of-range config with zero target mutation',
  (t) => {
    const cases = [
      ['legacy-v1', (value) => ({ ...value.signer, version: 1 }),
        /configuration_v2_required/],
      ['unknown-field', (value) => ({ ...value.signer, unknown: true }),
        /configuration_invalid/],
      ['out-of-range', (value) => ({
        ...value.signer,
        socketPolicy: { ...value.signer.socketPolicy, idleTimeoutMs: 999 },
      }), /socket_policy_invalid/],
    ];
    for (const [name, invalidSigner, expected] of cases) {
      const root = fixtureRoot(t, `hepta-attestor-install-${name}-`);
      const value = provisionLocalReleaseAttestorDeploymentFixture(root);
      value.writeConfigurations({
        selectedSigner: invalidSigner(value),
        selectedProbe: value.probe,
      });
      const before = contentSnapshot(root);
      const result = runInstaller(root);
      assert.equal(result.status, 78, `${name}: ${result.stderr}`);
      assert.match(result.stderr, expected, name);
      assert.match(result.stderr, /failed before installation mutation/, name);
      assert.match(
        result.stderr,
        /migration: stage both version 2 configurations/,
        name,
      );
      assert.deepEqual(contentSnapshot(root), before, name);
      assert.equal(fs.existsSync(path.join(root, 'usr')), false, name);
      assert.equal(fs.existsSync(path.join(root, 'etc', 'systemd')), false, name);
    }
});

test('host installer parses explicit full-auto requests but blocks them before target mutation',
  (t) => {
    const root = fixtureRoot(t, 'hepta-full-auto-install-blocked-');
    const before = contentSnapshot(root);
    const result = runInstaller(root, ['--enable-full-auto']);
    assert.equal(result.status, 78, result.stderr);
    assert.match(
      result.stderr,
      /hepta_full_auto_enable_blocked:non_mutating_accepted_readiness_preflight_unavailable/,
    );
    assert.match(result.stderr, /production hold remains required/);
    assert.deepEqual(contentSnapshot(root), before);
    assert.equal(fs.existsSync(path.join(root, 'usr')), false);
    assert.equal(fs.existsSync(path.join(root, 'etc')), false);

    const duplicate = runInstaller(root, [
      '--enable-full-auto',
      '--enable-full-auto',
    ]);
    assert.equal(duplicate.status, 64, duplicate.stderr);
    assert.match(duplicate.stderr, /duplicate option: --enable-full-auto/);
    assert.deepEqual(contentSnapshot(root), before);
  });

test('host installer defaults to a persistent hold with no implicit automation start', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  const systemdTransaction = source.slice(source.indexOf(
    'if [ "$manage_systemd" = yes ]; then',
  ));
  const enabledUnits = systemdTransaction.match(
    /systemctl enable \\\n([\s\S]*?)\n  \/usr\/bin\/systemctl stop/,
  )?.[1] || '';
  for (const unit of [
    'autonomous-research-supervisor.service',
    'autonomous-submission-dispatcher.service',
    'strict-full-auto-acceptance.service',
    'strict-full-auto-acceptance.timer',
  ]) {
    assert.match(
      systemdTransaction,
      new RegExp(`systemctl disable --now[\\s\\S]*${unit.replaceAll('.', '\\.')}`),
      unit,
    );
    assert.doesNotMatch(enabledUnits, new RegExp(unit.replaceAll('.', '\\.')), unit);
  }
  assert.doesNotMatch(
    systemdTransaction,
    /systemctl (?:start|restart)(?: --no-block)? [^\n]*(?:autonomous-research-supervisor|autonomous-submission-dispatcher|strict-full-auto-acceptance)/,
  );
  assert.match(systemdTransaction, /production hold active/);
});

test('host installer orders candidate preflight before compiler, install, and restart', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  const fullAutoBlocker = source.indexOf('hepta_full_auto_enable_blocked:');
  const preflight = source.indexOf('--preflight-configuration-pair');
  const compiler = source.indexOf('compiler=/usr/bin/cc');
  const install = source.indexOf('/usr/bin/install -d');
  const restart = source.indexOf(
    '/usr/bin/systemctl restart hepta-paper-release-attestor.service',
  );
  assert.ok(fullAutoBlocker > 0);
  assert.ok(fullAutoBlocker < preflight);
  assert.ok(preflight > 0);
  assert.ok(preflight < compiler);
  assert.ok(compiler < install);
  assert.ok(install < restart);
  assert.match(source, /if ! \/usr\/bin\/env -i[\s\S]*preflight-configuration-pair/);
});
