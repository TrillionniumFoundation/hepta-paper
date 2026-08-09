import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  verifyAutonomousSubmissionHandoffLayoutReceipt,
} from '../../paper-adapters/automation/autonomous-submission-handoff-layout-receipt-repository.mjs';
import {
  provisionLocalReleaseAttestorDeploymentFixture,
} from './support/local-release-attestor-deployment-fixture.mjs';

const WORKSPACE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);
const DEPLOY_ROOT = path.join(WORKSPACE_ROOT, 'paper-core', 'deploy');
const SOURCE_PATH = path.join(
  DEPLOY_ROOT,
  'autonomous-submission-handoff-layout-provision.c',
);
const HARDENING_FLAGS = Object.freeze([
  '-O2',
  '-std=c17',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-fPIE',
  '-fstack-protector-strong',
  '-D_FORTIFY_SOURCE=2',
]);
const LINKER_FLAGS = Object.freeze([
  '-pie',
  '-Wl,-z,relro,-z,now',
  '-Wl,-z,noexecstack',
]);

function commandAvailable(command) {
  return spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: 'ignore',
  }).status === 0;
}

function compileHelper(t, identities) {
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-layout-build-'));
  t.after(() => fs.rmSync(buildRoot, { recursive: true, force: true }));
  fs.chmodSync(buildRoot, 0o755);
  const binaryPath = path.join(
    buildRoot,
    'autonomous-submission-handoff-layout-provision',
  );
  const result = spawnSync('cc', [
    ...HARDENING_FLAGS,
    '-DHEPTA_LAYOUT_TEST_MODE',
    `-DHEPTA_TEST_SUPERVISOR_UID=${identities.supervisorUid}`,
    `-DHEPTA_TEST_SUPERVISOR_GID=${identities.supervisorGid}`,
    `-DHEPTA_TEST_DISPATCHER_UID=${identities.dispatcherUid}`,
    `-DHEPTA_TEST_DISPATCHER_GID=${identities.dispatcherGid}`,
    `-DHEPTA_TEST_HANDOFF_GID=${identities.handoffGid}`,
    `-DHEPTA_TEST_ROOT_UID=${identities.rootUid}`,
    SOURCE_PATH,
    ...LINKER_FLAGS,
    '-o',
    binaryPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function fixture(t, label, {
  supervisorUid = process.getuid(),
  supervisorGid = process.getgid(),
  rootUid = process.getuid(),
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o755);
  const runtimeRoot = path.join(root, 'runtime');
  const researchRoot = path.join(runtimeRoot, 'autonomous-research');
  const handoffRoot = path.join(researchRoot, 'submission-handoff');
  const receiptRoot = path.join(root, 'receipt');
  fs.mkdirSync(handoffRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(receiptRoot, { mode: 0o750 });
  for (const candidate of [runtimeRoot, researchRoot, handoffRoot]) {
    fs.chownSync(candidate, supervisorUid, supervisorGid);
    fs.chmodSync(candidate, 0o700);
  }
  fs.chownSync(receiptRoot, rootUid, supervisorGid);
  fs.chmodSync(receiptRoot, 0o750);
  const databasePath = path.join(handoffRoot, 'submission-handoff.sqlite');
  const databaseBytes = Buffer.from(
    'fixture-sqlite-content-must-not-change\n',
  );
  fs.writeFileSync(databasePath, databaseBytes, { mode: 0o600 });
  fs.chownSync(databasePath, supervisorUid, supervisorGid);
  const receiptPath = path.join(receiptRoot, 'layout.receipt.json');
  return Object.freeze({
    root,
    runtimeRoot,
    researchRoot,
    handoffRoot,
    receiptRoot,
    receiptPath,
    databasePath,
    databaseBytes,
  });
}

function runHelper(binaryPath, value, { verify = false, identity = null } = {}) {
  const args = verify
    ? [
      '--verify-layout-receipt',
      '--runtime-root',
      value.runtimeRoot,
      '--receipt-path',
      value.receiptPath,
    ]
    : [
      '--runtime-root',
      value.runtimeRoot,
      '--receipt-path',
      value.receiptPath,
    ];
  const command = identity ? 'setpriv' : binaryPath;
  const commandArgs = identity ? [
    '--reuid',
    String(identity.uid),
    '--regid',
    String(identity.gid),
    '--groups',
    identity.groups.map(String).join(','),
    binaryPath,
    ...args,
  ] : args;
  return spawnSync(command, commandArgs, {
    encoding: 'utf8',
    env: { PATH: '/usr/sbin:/usr/bin' },
  });
}

function mode(candidate) {
  return fs.lstatSync(candidate).mode & 0o7777;
}

function sha256(candidate) {
  return `sha256:${crypto.createHash('sha256')
    .update(fs.readFileSync(candidate)).digest('hex')}`;
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('native warning gate and idempotent no-content convergence preserve DB bytes and inode',
  { skip: !commandAvailable('cc') },
  (t) => {
    const identity = {
      supervisorUid: process.getuid(),
      supervisorGid: process.getgid(),
      dispatcherUid: process.getuid(),
      dispatcherGid: process.getgid(),
      handoffGid: process.getgid(),
      rootUid: process.getuid(),
    };
    const binaryPath = compileHelper(t, identity);
    const value = fixture(t, 'hepta-handoff-layout-');
    const databaseBefore = fs.statSync(value.databasePath);
    const databaseHashBefore = sha256(value.databasePath);
    const first = assertSuccess(runHelper(binaryPath, value));
    assert.equal(first.ready, true);
    assert.equal(first.databaseSha256, databaseHashBefore);
    assert.equal(first.databaseContentCreated, false);
    assert.equal(first.credentialContentCreated, false);
    assert.equal(first.authorityContentCreated, false);
    assert.equal(mode(value.runtimeRoot), 0o710);
    assert.equal(mode(value.researchRoot), 0o710);
    assert.equal(mode(value.handoffRoot), 0o3770);
    assert.equal(mode(value.databasePath), 0o660);
    assert.equal(mode(path.join(value.handoffRoot, 'dispatcher-challenges')), 0o2750);
    assert.equal(mode(path.join(value.handoffRoot, 'dispatcher-cycles')), 0o2750);
    assert.equal(mode(value.receiptPath), 0o440);
    assert.deepEqual(fs.readFileSync(value.databasePath), value.databaseBytes);
    const verified = verifyAutonomousSubmissionHandoffLayoutReceipt({
      runtimeRoot: value.runtimeRoot,
      receiptPath: value.receiptPath,
      helperPath: binaryPath,
    });
    assert.equal(
      verified.status,
      'autonomous_submission_handoff_layout_receipt_verified',
    );
    const repeated = assertSuccess(runHelper(binaryPath, value));
    const databaseAfter = fs.statSync(value.databasePath);
    assert.equal(repeated.databaseSha256, databaseHashBefore);
    assert.equal(databaseAfter.dev, databaseBefore.dev);
    assert.equal(databaseAfter.ino, databaseBefore.ino);
    assert.equal(databaseAfter.size, databaseBefore.size);
    assert.equal(sha256(value.databasePath), databaseHashBefore);
    fs.appendFileSync(value.databasePath, 'legitimate-online-sqlite-growth');
    fs.writeFileSync(
      path.join(value.handoffRoot, 'dispatcher-challenges', 'challenge.json'),
      '{}',
    );
    fs.writeFileSync(
      path.join(value.handoffRoot, 'dispatcher-cycles', 'cycle.json'),
      '{}',
    );
    assert.equal(
      assertSuccess(runHelper(binaryPath, value, { verify: true })).status,
      'autonomous_submission_handoff_layout_receipt_verified',
    );
  });

test('symlink, hard-linked DB, missing DB, and receipt tamper fail closed',
  { skip: !commandAvailable('cc') },
  (t) => {
    const identity = {
      supervisorUid: process.getuid(),
      supervisorGid: process.getgid(),
      dispatcherUid: process.getuid(),
      dispatcherGid: process.getgid(),
      handoffGid: process.getgid(),
      rootUid: process.getuid(),
    };
    const binaryPath = compileHelper(t, identity);

    const linked = fixture(t, 'hepta-handoff-layout-symlink-');
    const outside = path.join(linked.root, 'outside');
    fs.mkdirSync(outside, { mode: 0o755 });
    fs.symlinkSync(outside, path.join(linked.handoffRoot, 'dispatcher-cycles'));
    const handoffMode = mode(linked.handoffRoot);
    const databaseMode = mode(linked.databasePath);
    const linkedResult = runHelper(binaryPath, linked);
    assert.notEqual(linkedResult.status, 0);
    assert.match(linkedResult.stderr, /layout_directory_unsafe/);
    assert.equal(mode(linked.handoffRoot), handoffMode);
    assert.equal(mode(linked.databasePath), databaseMode);
    assert.equal(mode(outside), 0o755);

    const hardLinked = fixture(t, 'hepta-handoff-layout-hardlink-');
    fs.linkSync(
      hardLinked.databasePath,
      path.join(hardLinked.root, 'database-hardlink'),
    );
    const hardLinkResult = runHelper(binaryPath, hardLinked);
    assert.notEqual(hardLinkResult.status, 0);
    assert.match(hardLinkResult.stderr, /offline_store_required/);

    const missing = fixture(t, 'hepta-handoff-layout-missing-');
    fs.unlinkSync(missing.databasePath);
    const missingResult = runHelper(binaryPath, missing);
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /offline_store_required/);
    assert.deepEqual(fs.readdirSync(missing.handoffRoot), []);

    const tampered = fixture(t, 'hepta-handoff-layout-tamper-');
    assertSuccess(runHelper(binaryPath, tampered));
    fs.chmodSync(tampered.receiptPath, 0o640);
    fs.appendFileSync(tampered.receiptPath, 'tamper');
    const tamperResult = runHelper(binaryPath, tampered, { verify: true });
    assert.notEqual(tamperResult.status, 0);
    assert.match(tamperResult.stderr, /receipt_(metadata|content)_invalid/);

    const metadataDrift = fixture(t, 'hepta-handoff-layout-metadata-drift-');
    assertSuccess(runHelper(binaryPath, metadataDrift));
    fs.chmodSync(metadataDrift.databasePath, 0o600);
    const metadataResult = runHelper(binaryPath, metadataDrift, { verify: true });
    assert.notEqual(metadataResult.status, 0);
    assert.match(metadataResult.stderr, /database_metadata_invalid/);

    const inodeDrift = fixture(t, 'hepta-handoff-layout-inode-drift-');
    assertSuccess(runHelper(binaryPath, inodeDrift));
    const displaced = `${inodeDrift.databasePath}.old`;
    fs.renameSync(inodeDrift.databasePath, displaced);
    fs.writeFileSync(inodeDrift.databasePath, inodeDrift.databaseBytes, { mode: 0o660 });
    fs.chownSync(
      inodeDrift.databasePath,
      identity.supervisorUid,
      identity.handoffGid,
    );
    fs.chmodSync(inodeDrift.databasePath, 0o660);
    const inodeResult = runHelper(binaryPath, inodeDrift, { verify: true });
    assert.notEqual(inodeResult.status, 0);
    assert.match(inodeResult.stderr, /database_receipt_drift/);
  });

test('distinct native principals enforce the exact fresh-host DAC matrix',
  {
    skip: process.geteuid() !== 0
      || !commandAvailable('cc')
      || !commandAvailable('setpriv'),
  },
  (t) => {
    const identity = {
      supervisorUid: 31_001,
      supervisorGid: 31_001,
      dispatcherUid: 31_002,
      dispatcherGid: 31_002,
      handoffGid: 31_003,
      rootUid: 0,
    };
    const binaryPath = compileHelper(t, identity);
    const value = fixture(t, 'hepta-handoff-layout-dac-', identity);
    const nativeDatabase = path.join(value.runtimeRoot, 'hepta-paper.sqlite');
    fs.writeFileSync(nativeDatabase, 'native', { mode: 0o600 });
    fs.chownSync(nativeDatabase, identity.supervisorUid, identity.supervisorGid);
    const databaseHashBefore = sha256(value.databasePath);
    assertSuccess(runHelper(binaryPath, value));

    const asSupervisor = (args) => spawnSync('setpriv', [
      '--reuid',
      String(identity.supervisorUid),
      '--regid',
      String(identity.supervisorGid),
      '--groups',
      String(identity.handoffGid),
      ...args,
    ], { encoding: 'utf8' });
    const asDispatcher = (args) => spawnSync('setpriv', [
      '--reuid',
      String(identity.dispatcherUid),
      '--regid',
      String(identity.dispatcherGid),
      '--groups',
      String(identity.handoffGid),
      ...args,
    ], { encoding: 'utf8' });
    const challenges = path.join(value.handoffRoot, 'dispatcher-challenges');
    const cycles = path.join(value.handoffRoot, 'dispatcher-cycles');
    assert.equal(asSupervisor(['/usr/bin/test', '-w', challenges]).status, 0);
    assert.notEqual(asSupervisor(['/usr/bin/test', '-w', cycles]).status, 0);
    assert.equal(asDispatcher(['/usr/bin/test', '-w', value.databasePath]).status, 0);
    assert.notEqual(asDispatcher(['/usr/bin/test', '-w', nativeDatabase]).status, 0);
    assert.notEqual(asDispatcher(['/usr/bin/test', '-w', challenges]).status, 0);
    assert.equal(asDispatcher(['/usr/bin/test', '-w', cycles]).status, 0);
    assert.equal(asSupervisor(['/usr/bin/test', '-r', value.receiptPath]).status, 0);
    assert.notEqual(asSupervisor(['/usr/bin/test', '-w', value.receiptRoot]).status, 0);
    assertSuccess(runHelper(binaryPath, value, {
      verify: true,
      identity: {
        uid: identity.supervisorUid,
        gid: identity.supervisorGid,
        groups: [identity.handoffGid],
      },
    }));
    assert.equal(sha256(value.databasePath), databaseHashBefore);
  });

test('tmpfiles creates a missing durable parent without touching an existing runtime',
  { skip: !commandAvailable('systemd-tmpfiles') },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-tmpfiles-root-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fragment = path.join(root, 'hepta-paper.test-tmpfiles.conf');
    fs.mkdirSync(path.join(root, 'run'));
    fs.writeFileSync(fragment, [
      `d /run/hepta-paper-deployment 0711 ${process.getuid()} ${process.getgid()} -`,
      `f /run/hepta-paper-deployment/deployment.lock 0600 ${process.getuid()} ${process.getgid()} -`,
      `d /var/lib/hepta-paper 0710 ${process.getuid()} ${process.getgid()} -`,
      `d /var/lib/hepta-paper/strict-full-auto-acceptance-control 0700 ${process.getuid()} ${process.getgid()} -`,
      '',
    ].join('\n'));
    const first = spawnSync('systemd-tmpfiles', [
      `--root=${root}`,
      '--create',
      fragment,
    ], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const deploymentLock = path.join(
      root,
      'run',
      'hepta-paper-deployment',
      'deployment.lock',
    );
    assert.equal(mode(deploymentLock), 0o600);
    assert.equal(fs.statSync(deploymentLock).nlink, 1);
    assert.equal(fs.statSync(deploymentLock).size, 0);
    const durableParent = path.join(root, 'var', 'lib', 'hepta-paper');
    assert.equal(mode(durableParent), 0o710);
    assert.equal(
      mode(path.join(
        durableParent,
        'strict-full-auto-acceptance-control',
      )),
      0o700,
    );
    assert.equal(fs.existsSync(path.join(durableParent, 'runtime')), false);

    const runtimeRoot = path.join(durableParent, 'runtime');
    fs.mkdirSync(runtimeRoot, { mode: 0o710 });
    const databasePath = path.join(runtimeRoot, 'hepta-paper.sqlite');
    fs.writeFileSync(databasePath, 'durable-state', { mode: 0o600 });
    const runtimeBefore = fs.statSync(runtimeRoot);
    const databaseBefore = fs.statSync(databasePath);
    const databaseHashBefore = sha256(databasePath);
    const deploymentLockBefore = fs.statSync(deploymentLock);
    const repeated = spawnSync('systemd-tmpfiles', [
      `--root=${root}`,
      '--create',
      fragment,
    ], { encoding: 'utf8' });
    assert.equal(repeated.status, 0, repeated.stderr);
    const runtimeAfter = fs.statSync(runtimeRoot);
    const databaseAfter = fs.statSync(databasePath);
    const deploymentLockAfter = fs.statSync(deploymentLock);
    assert.equal(runtimeAfter.dev, runtimeBefore.dev);
    assert.equal(runtimeAfter.ino, runtimeBefore.ino);
    assert.equal(runtimeAfter.uid, runtimeBefore.uid);
    assert.equal(runtimeAfter.gid, runtimeBefore.gid);
    assert.equal(databaseAfter.dev, databaseBefore.dev);
    assert.equal(databaseAfter.ino, databaseBefore.ino);
    assert.equal(databaseAfter.uid, databaseBefore.uid);
    assert.equal(databaseAfter.gid, databaseBefore.gid);
    assert.equal(sha256(databasePath), databaseHashBefore);
    assert.equal(deploymentLockAfter.dev, deploymentLockBefore.dev);
    assert.equal(deploymentLockAfter.ino, deploymentLockBefore.ino);
    assert.equal(deploymentLockAfter.size, 0);
  });

test('systemd bootstrap, isolated layout service, and installer form a fresh-host chain',
  (t) => {
    const sysusers = fs.readFileSync(
      path.join(DEPLOY_ROOT, 'hepta-paper.sysusers.conf'),
      'utf8',
    );
    const tmpfiles = fs.readFileSync(
      path.join(DEPLOY_ROOT, 'hepta-paper.tmpfiles.conf'),
      'utf8',
    );
    assert.match(sysusers, /^g hepta-runtime-handoff -$/m);
    assert.match(sysusers, /^g hepta-state-authority -$/m);
    assert.match(sysusers, /^u hepta-paper -:hepta-paper .* \/var\/lib\/hepta-paper \/usr\/sbin\/nologin$/m);
    assert.match(sysusers, /^u hepta-submission-dispatcher -:hepta-submission-dispatcher .* \/nonexistent \/usr\/sbin\/nologin$/m);
    assert.match(sysusers,
      /^u hepta-state-authority -:hepta-state-authority .* \/var\/lib\/hepta-paper-state-authority \/usr\/sbin\/nologin$/m);
    assert.equal((sysusers.match(/^m .* hepta-runtime-handoff$/gm) || []).length, 2);
    assert.doesNotMatch(sysusers, /^m hepta-paper hepta-state-authority$/m);
    assert.doesNotMatch(sysusers, /docker|secret|credential/i);
    assert.match(
      tmpfiles,
      /^d \/run\/hepta-paper-deployment 0711 root root -$/m,
    );
    assert.match(
      tmpfiles,
      /^f \/run\/hepta-paper-deployment\/deployment\.lock 0600 root root -$/m,
    );
    assert.match(
      tmpfiles,
      /^d \/var\/lib\/hepta-paper 0710 hepta-paper hepta-runtime-handoff -$/m,
    );
    assert.match(
      tmpfiles,
      /^d \/var\/lib\/hepta-paper\/strict-full-auto-acceptance-control 0700 hepta-paper hepta-paper -$/m,
    );
    assert.doesNotMatch(tmpfiles, /^d \/var\/lib\/hepta-paper\/runtime\b/m);

    const bootstrap = fs.readFileSync(
      path.join(DEPLOY_ROOT, 'hepta-paper-host-bootstrap.service'),
      'utf8',
    );
    assert.doesNotMatch(bootstrap, /^EnvironmentFile=/m);
    assert.equal((bootstrap.match(/^ExecStart=\/usr\/bin\/env -i /gm) || []).length, 3);
    assert.match(bootstrap, /systemd-sysusers \/usr\/lib\/sysusers\.d\/hepta-paper\.conf/);
    assert.match(bootstrap, /systemd-tmpfiles --create \/usr\/lib\/tmpfiles\.d\/hepta-paper\.conf/);
    assert.match(bootstrap, /--verify-identities$/m);
    assert.match(bootstrap, /^CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER$/m);
    assert.match(bootstrap, /^ProtectSystem=strict$/m);
    assert.match(bootstrap, /^ReadWritePaths=\/etc \/var\/lib$/m);
    assert.match(bootstrap, /^RuntimeDirectory=hepta-paper-deployment$/m);
    assert.match(bootstrap, /^RuntimeDirectoryMode=0711$/m);
    assert.match(bootstrap, /^RuntimeDirectoryPreserve=yes$/m);
    assert.match(bootstrap, /^InaccessiblePaths=.*\/etc\/hepta-paper/m);

    const layout = fs.readFileSync(
      path.join(
        DEPLOY_ROOT,
        'autonomous-submission-handoff-layout-provision.service',
      ),
      'utf8',
    );
    assert.doesNotMatch(layout, /^EnvironmentFile=/m);
    assert.match(layout, /^ExecStart=\/usr\/bin\/env -i /m);
    assert.match(layout, /^Group=hepta-paper$/m);
    assert.match(layout, /^RuntimeDirectory=hepta-paper-handoff-layout$/m);
    assert.match(layout, /^RuntimeDirectoryMode=0750$/m);
    assert.match(layout, /^RuntimeDirectoryPreserve=yes$/m);
    assert.match(layout, /^RemainAfterExit=yes$/m);
    assert.match(layout,
      /^CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_FSETID$/m);
    assert.doesNotMatch(layout, /^RestrictSUIDSGID=yes$/m);
    assert.match(layout, /--receipt-path \/run\/hepta-paper-handoff-layout\//);
    assert.match(layout, /^ReadWritePaths=-\/var\/lib\/hepta-paper\/runtime /m);
    const watcher = fs.readFileSync(
      path.join(
        DEPLOY_ROOT,
        'autonomous-submission-handoff-layout-provision.path',
      ),
      'utf8',
    );
    assert.match(watcher, /^PathExists=.*submission-handoff\.sqlite$/m);
    assert.match(watcher, /^Requires=hepta-paper-host-bootstrap\.service$/m);

    for (const name of [
      'autonomous-research-supervisor.service',
      'autonomous-submission-dispatcher.service',
    ]) {
      const unit = fs.readFileSync(path.join(DEPLOY_ROOT, name), 'utf8');
      const expectedRequires = name === 'autonomous-research-supervisor.service'
        ? 'Requires=hepta-paper-host-bootstrap.service autonomous-submission-handoff-layout-provision.service hepta-paper-state-authority.service'
        : 'Requires=hepta-paper-host-bootstrap.service autonomous-submission-handoff-layout-provision.service';
      assert.match(unit, new RegExp(`^${expectedRequires.replaceAll('.', '\\.')}$`, 'm'));
      assert.match(unit, /^Wants=.*autonomous-submission-handoff-layout-provision\.path/m);
      assert.doesNotMatch(unit, /^ExecStartPre=\+/m);
      assert.match(unit, /^Restart=always$/m);
    }
    const supervisor = fs.readFileSync(
      path.join(DEPLOY_ROOT, 'autonomous-research-supervisor.service'),
      'utf8',
    );
    assert.match(supervisor, /^After=.*docker\.service$/m);
    assert.match(supervisor, /^Wants=.*docker\.service$/m);
    assert.match(supervisor,
      /^SupplementaryGroups=docker hepta-runtime-handoff$/m);
    const strict = fs.readFileSync(
      path.join(DEPLOY_ROOT, 'strict-full-auto-acceptance.service'),
      'utf8',
    );
    const strictTimer = fs.readFileSync(
      path.join(DEPLOY_ROOT, 'strict-full-auto-acceptance.timer'),
      'utf8',
    );
    assert.match(strict, /^Requires=hepta-paper-host-bootstrap\.service$/m);
    assert.match(strict,
      /^After=.*autonomous-submission-handoff-layout-provision\.path/m);
    assert.match(strictTimer, /^OnUnitInactiveSec=5min$/m);
    assert.match(strictTimer,
      /^Unit=strict-full-auto-acceptance\.service$/m);

    const installerPath = path.join(
      DEPLOY_ROOT,
      'install-hepta-paper-systemd-host.sh',
    );
    const installer = fs.readFileSync(installerPath, 'utf8');
    assert.match(installer, /-std=c17 -Wall -Wextra -Werror/);
    assert.match(installer, /source_sha256/);
    assert.match(installer, /binary_sha256/);
    assert.match(installer, /compiler_sha256/);
    assert.match(installer, /HEPTA_HOST_INSTALL_SANITIZED/);
    assert.match(installer, /cp --no-dereference --reflink=never/);
    assert.match(installer, /snapshot_hash/);
    assert.match(installer, /installed deployment artifact hash mismatch/);
    assert.match(installer, /hepta-paper-systemd-host\.manifest\.sha256/);
    assert.match(installer, /systemctl daemon-reload/);
    assert.match(installer,
      /systemctl disable --now \\\n    strict-full-auto-acceptance\.timer \\\n    strict-full-auto-acceptance\.service \\\n    autonomous-submission-dispatcher\.service \\\n    autonomous-research-supervisor\.service/);
    const enabledUnits = installer.match(
      /systemctl enable \\\n([\s\S]*?)\n  \/usr\/bin\/systemctl stop/,
    )?.[1] || '';
    assert.match(enabledUnits, /hepta-paper-state-authority\.service/);
    assert.match(enabledUnits, /autonomous-research-state-backup-renew\.timer/);
    assert.doesNotMatch(enabledUnits,
      /autonomous-research-supervisor|autonomous-submission-dispatcher|strict-full-auto/);
    assert.match(installer, /--enable-full-auto/);
    assert.match(installer,
      /hepta_full_auto_enable_blocked:non_mutating_accepted_readiness_preflight_unavailable/);
    assert.doesNotMatch(installer,
      /systemctl restart strict-full-auto-acceptance\.timer/);
    assert.doesNotMatch(installer,
      /systemctl start --no-block strict-full-auto-acceptance\.service/);
    assert.match(installer,
      /hepta-paper systemd host installation completed \(production hold active\)/);
    assert.equal(spawnSync('sh', ['-n', installerPath]).status, 0);

    if (commandAvailable('cc') && commandAvailable('systemd-analyze')) {
      const installRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'hepta-host-install-destdir-'),
      );
      t.after(() => fs.rmSync(installRoot, { recursive: true, force: true }));
      provisionLocalReleaseAttestorDeploymentFixture(installRoot);
      const installation = spawnSync(installerPath, [
        '--root',
        installRoot,
        '--no-systemctl',
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GCC_EXEC_PREFIX: '/must-not-be-inherited',
          COMPILER_PATH: '/must-not-be-inherited',
          LIBRARY_PATH: '/must-not-be-inherited',
        },
      });
      assert.equal(installation.status, 0, installation.stderr);
      assert.match(
        installation.stdout,
        /hepta-paper systemd host installation completed/,
      );
      const manifestPath = path.join(
        installRoot,
        'usr',
        'share',
        'hepta-paper',
        'deploy',
        'hepta-paper-systemd-host.manifest.sha256',
      );
      const manifestVerification = spawnSync('sha256sum', [
        '-c',
        path.relative(installRoot, manifestPath),
      ], { cwd: installRoot, encoding: 'utf8' });
      assert.equal(
        manifestVerification.status,
        0,
        manifestVerification.stderr,
      );
      assert.equal(
        mode(path.join(
          installRoot,
          'usr',
          'libexec',
          'hepta-paper',
          'autonomous-submission-handoff-layout-provision',
        )),
        0o755,
      );
      for (const launcher of [
        'codex-openclaw-managed',
        'hepta-paper-state-authority-client',
        'hepta-paper-release-attestor-client',
        'hepta-paper-release-env',
      ]) {
        const expectedInstallerUid = process.getuid() === 0 ? 0 : process.getuid();
        const expectedInstallerGid = process.getuid() === 0 ? 0 : process.getgid();
        const installedLauncher = path.join(
          installRoot,
          'usr',
          'libexec',
          'hepta-paper',
          launcher,
        );
        assert.equal(mode(installedLauncher), 0o755, launcher);
        const stat = fs.statSync(installedLauncher);
        assert.equal(stat.uid, expectedInstallerUid, launcher);
        assert.equal(stat.gid, expectedInstallerGid, launcher);
      }
      assert.equal(
        mode(path.join(
          installRoot,
          'etc',
          'systemd',
          'system',
          'hepta-paper-host-bootstrap.service',
        )),
        0o644,
      );
    }

    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    for (const primitive of [
      'SYS_openat2',
      'RESOLVE_BENEATH',
      'RESOLVE_NO_SYMLINKS',
      'mkdirat(',
      'fstatat(',
      'getsgent(',
      'getgrouplist(',
      'SUPERVISOR_RUNTIME_GROUP',
      'require_exact_public_group_memberships(',
      'autonomous_submission_handoff_persistent_supplementary_group_forbidden',
      'autonomous_submission_handoff_primary_group_shadow_members_invalid',
      'sha256_fd(',
      'O_RDONLY | O_CLOEXEC | O_NOFOLLOW',
      'PRODUCTION_RUNTIME_ROOT',
      'PRODUCTION_RECEIPT_PATH',
    ]) assert.ok(source.includes(primitive), primitive);

    if (commandAvailable('systemd-analyze')) {
      const verification = spawnSync('systemd-analyze', [
        'verify',
        path.join(DEPLOY_ROOT, 'hepta-paper-host-bootstrap.service'),
        path.join(
          DEPLOY_ROOT,
          'autonomous-submission-handoff-layout-provision.service',
        ),
        path.join(
          DEPLOY_ROOT,
          'autonomous-submission-handoff-layout-provision.path',
        ),
        path.join(DEPLOY_ROOT, 'autonomous-research-supervisor.service'),
        path.join(DEPLOY_ROOT, 'autonomous-submission-dispatcher.service'),
        path.join(DEPLOY_ROOT, 'strict-full-auto-acceptance.service'),
        path.join(DEPLOY_ROOT, 'strict-full-auto-acceptance.timer'),
      ], { encoding: 'utf8' });
      assert.equal(verification.status, 0, verification.stderr);
    }
  });
