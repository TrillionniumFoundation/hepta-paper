import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { lockedParentOracleRuntimePaths, assertLockedParentOracleNodeCopy } from '../bin/with-locked-parent-node-oracle.mjs';
const approved = '/opt/hostedtoolcache/node/22.23.1/x64/lib/node_modules/npm/bin/npm-cli.js';
const input = { execPath: '/usr/bin/node', nodeVersion: '22.23.1', architecture: 'x64', npmExecPath: approved };
test('explicit CI runtime selects only the exact official pair, never PATH', () => {
  assert.deepEqual(lockedParentOracleRuntimePaths(input), { node: '/opt/hostedtoolcache/node/22.23.1/x64/bin/node', npm: approved, copiedSystemNode: true });
  for (const changed of [{ npmExecPath: '/tmp/npm-cli.js' }, { npmExecPath: 'npm' }, { npmExecPath: '' }, { execPath: '/tmp/node' }, { nodeVersion: '22.23.2' }, { architecture: 'unknown' }]) {
    assert.throws(() => lockedParentOracleRuntimePaths({ ...input, ...changed }), /not_approved/);
  }
});
test('same-installation original path stays explicit when no override was supplied', () => {
  const selected = lockedParentOracleRuntimePaths({ execPath: '/opt/node/bin/node', nodeVersion: '22.23.1', architecture: 'x64' });
  assert.equal(selected.npm, '/opt/node/lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(selected.copiedSystemNode, false);
});
test('copied system Node requires exact bytes, root owner and nonwritable permissions', () => {
  const system = { path: '/usr/bin/node', identity: ['1', '2', String(0o100555), '0', '0'], sha256: 'exact-source-bytes' };
  const installation = { sha256: system.sha256 };
  assert.doesNotThrow(() => assertLockedParentOracleNodeCopy(system, installation));
  for (const changed of [{ path: '/tmp/node' }, { sha256: 'different' }, { identity: ['1', '2', String(0o100575), '0', '0'] }, { identity: ['1', '2', String(0o100555), '1000', '0'] }, { identity: ['1', '2', String(0o100555), '0', '1000'] }]) {
    assert.throws(() => assertLockedParentOracleNodeCopy({ ...system, ...changed }, installation), /system_node_copy_not_bound/);
  }
});

// Execute the actual wrapper and CLI bodies with clock, process and filesystem
// effects replaced in a VM. No child, installation or temporary file is created.
const wrapperSource = fs.readFileSync(new URL('../bin/with-locked-parent-node-oracle.mjs', import.meta.url), 'utf8');
function budgetHarness({ times = [0, 0, 0, 0], results = [], argv = [], environment = {} } = {}) {
  const calls = [], receipts = [], observations = [], effects = [];
  let clock = 0;
  const context = {
    Buffer, path,
    performance: { now() { assert.ok(clock < times.length, 'unexpected clock reset/read'); return times[clock++]; } },
    process: { version: 'v22.23.1', versions: { node: '22.23.1' }, arch: 'x64', execPath: '/opt/node/bin/node',
      getuid: () => 1000, cwd: () => '/fixture/candidate', env: environment,
      argv: argv.length ? ['node', '/wrapper.mjs', ...argv] : [] },
    fs: {
      realpathSync(file) { effects.push(['realpath', file]); return file; },
      existsSync: () => false,
      lstatSync(file) {
        if (file === '/fixture') return { uid: 1000 };
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      },
    },
    fileURLToPath: () => '/wrapper.mjs',
    spawnSync(file, args, options) {
      calls.push({ file, args: [...args], options });
      const result = results[calls.length - 1] ?? { status: 0, stdout: '10.9.8\n' };
      if (result instanceof Error) throw result;
      return result;
    },
    buildProductionStrictNpmAuditInvocation() { assert.fail('unexpected copied-runtime binding'); },
    record(file, raw = Buffer.from('{}')) {
      return { path: file, raw, identity: ['fixed'], sha256: 'fixed', limit: 1024 };
    },
    receipts, observations, effects,
  };
  const source = wrapperSource.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    .replace('import.meta.url', "'file:///wrapper.mjs'");
  const marker = '\nif (process.argv[1]';
  assert.equal(source.split(marker).length, 2, 'keep the real CLI body in the VM');
  const substitutions = `
regular = file => record(file, Buffer.from(JSON.stringify(file.endsWith('/package.json')
  ? { packageManager: 'npm@10.9.8' } : { lockfileVersion: 3 })));
create = (file, raw) => { effects.push(['create', file]); if (file === '/receipt.json') receipts.push(JSON.parse(raw)); return record(file, raw); };
sameFile = pin => observations.push(['file', pin.path]);
closure = directory => { observations.push(['closure', directory]); return { rows: [directory], totalBytes: 0 }; };
`;
  const [body, cli] = source.split(marker);
  vm.runInNewContext(body + substitutions + marker + cli, context);
  return { calls, receipts, observations, effects, process: context.process,
    run: (options = {}) => context.withLockedParentNodeOracle({ root: '/fixture/candidate', receipt: '/receipt.json',
      command: ['/verification', 'argument'], ...options }) };
}

test('wrapper profiles share one original decreasing deadline across version, install and verification', () => {
  for (const [budgetProfile, milliseconds] of [['default', 1800000], ['functional-ci', 3300000]]) {
    const harness = budgetHarness({ times: [100, 1100, 60100, 120100] });
    assert.equal(harness.run({ budgetProfile }), 0);
    assert.deepEqual(harness.calls.map(call => call.options.timeout), [milliseconds - 1000, milliseconds - 60000, milliseconds - 120000]);
    assert.deepEqual(harness.calls.map(call => [call.file, call.args]), [
      ['/opt/node/bin/node', ['/opt/node/lib/node_modules/npm/bin/npm-cli.js', '--version']],
      ['/opt/node/bin/node', ['/opt/node/lib/node_modules/npm/bin/npm-cli.js', 'ci', '--prefix', '/fixture',
        '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig=/fixture/.hepta-npm-user', '--globalconfig=/fixture/.hepta-npm-global']],
      ['/verification', ['argument']],
    ]);
    assert.ok(harness.calls.every(call => call.options.shell === false));
    assert.equal(harness.receipts[0].actualExitCode, 0);
    assert.equal(harness.receipts[0].sourceQualificationClaimed, false);
    assert.deepEqual(harness.receipts[0].dependencyBefore, harness.receipts[0].dependencyAfter);
    assert.deepEqual(harness.receipts[0].npmBefore, harness.receipts[0].npmAfter);
  }
});

test('wrapper refuses an exhausted original deadline before each child, including the exact boundary', () => {
  for (const [budgetProfile, deadline] of [['default', 1800000], ['functional-ci', 3300000]]) {
    for (const expiry of [deadline, deadline + 1]) {
      for (let child = 0; child < 3; child++) {
        const harness = budgetHarness({ times: [0, ...Array(child).fill(0), expiry] });
        assert.throws(() => harness.run({ budgetProfile }), /parent_node_oracle_job_timeout/);
        assert.equal(harness.calls.length, child);
        assert.equal(harness.receipts.length, child === 2 ? 1 : 0);
        if (child === 2) assert.equal(harness.receipts[0].actualExitCode, null);
      }
    }
    const near = budgetHarness({ times: [0, 0, 0, deadline - 1] });
    assert.equal(near.run({ budgetProfile }), 0);
    assert.equal(near.calls[2].options.timeout, 1);
  }
});

test('wrapper keeps library and CLI defaults, with no environment or arbitrary timeout override', () => {
  const environment = { HEPTA_LOCKED_NODE_ORACLE_TIMEOUT: '999999999', HEPTA_LOCKED_NODE_ORACLE_BUDGET_PROFILE: 'functional-ci',
    npm_config_timeout: '999999999', budgetProfile: 'functional-ci' };
  const library = budgetHarness({ environment });
  assert.equal(library.run({ timeout: 999999999, timeoutSeconds: 999999999 }), 0);
  assert.deepEqual(library.calls.map(call => call.options.timeout), [1800000, 1800000, 1800000]);
  for (const [selected, timeout] of [[[], 1800000], [['--budget-profile', 'functional-ci'], 3300000]]) {
    const cli = budgetHarness({ environment, argv: ['--receipt', '/receipt.json', ...selected, '--', '/verification', 'argument'] });
    assert.equal(cli.process.exitCode, 0);
    assert.deepEqual(cli.calls.map(call => call.options.timeout), [timeout, timeout, timeout]);
    assert.deepEqual(cli.calls[2].args, ['argument']);
  }
  for (const budgetProfile of [null, true, false, 3300, 55, '', '3300', '55', 'functional-ci ', 'DEFAULT', {}, []]) {
    const harness = budgetHarness();
    assert.throws(() => harness.run({ budgetProfile }), /parent_node_oracle_budget_profile/);
    assert.equal(harness.effects.length, 0);
    assert.equal(harness.calls.length, 0);
  }
  for (const selected of [['--budget-profile', '3300'], ['--budget-profile', 'default'], ['--timeout', '3300'],
    ['--budget-profile=functional-ci'], ['--budget-profile', 'functional-ci', '--budget-profile', 'functional-ci']]) {
    assert.throws(() => budgetHarness({ argv: ['--receipt', '/receipt.json', ...selected, '--', '/verification'] }), /parent_node_oracle_arguments/);
  }
});

test('wrapper preserves child failures and final observations under the functional CI profile', () => {
  const ok = { status: 0, stdout: '10.9.8\n' };
  for (const result of [{ status: 1 }, { status: null, error: { code: 'ETIMEDOUT' } }]) {
    const version = budgetHarness({ results: [result] });
    assert.throws(() => version.run({ budgetProfile: 'functional-ci' }), /parent_node_oracle_actual_npm_version/);
    assert.equal(version.calls.length, 1);
    const install = budgetHarness({ results: [ok, result] });
    assert.throws(() => install.run({ budgetProfile: 'functional-ci' }), /parent_node_oracle_install_failed/);
    assert.equal(install.calls.length, 2);
    assert.equal(install.receipts.length, 0);
  }
  for (const result of [{ status: 23 }, { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }, new Error('spawn failure')]) {
    const harness = budgetHarness({ results: [ok, ok, result] });
    if (result.status === 23) assert.equal(harness.run({ budgetProfile: 'functional-ci' }), 23);
    else assert.throws(() => harness.run({ budgetProfile: 'functional-ci' }), /parent_node_oracle_command_not_terminal|spawn failure/);
    assert.equal(harness.calls.length, 3);
    assert.equal(harness.receipts.length, 1);
    assert.equal(harness.receipts[0].actualExitCode, result.status ?? null);
    assert.equal(harness.receipts[0].actualSignal, result.signal ?? null);
    assert.equal(harness.receipts[0].executionError, result.error?.code ?? null);
    assert.deepEqual(harness.observations.filter(row => row[0] === 'closure').map(row => row[1]),
      ['/opt/node/lib/node_modules/npm', '/fixture/node_modules', '/fixture/node_modules', '/opt/node/lib/node_modules/npm']);
  }
  const cli = budgetHarness({ results: [ok, ok, { status: 23 }],
    argv: ['--receipt', '/receipt.json', '--budget-profile', 'functional-ci', '--', '/verification'] });
  assert.equal(cli.process.exitCode, 23);
});

test('only the two functional workflow callers opt in, with exact producer pins and unchanged repository defaults', () => {
  const read = name => fs.readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
  const functionalPath = '.github/workflows/rust-functional-source-closure.yml';
  const functional = read(functionalPath), repository = read('.github/workflows/repository-source-evidence.yml');
  const invocations = source => source.split('\n').filter(line => line.includes('node paper-core/bin/with-locked-parent-node-oracle.mjs '));
  assert.deepEqual(invocations(functional).map(line => line.trim()), ['head', 'merge'].map(lane =>
    `node paper-core/bin/with-locked-parent-node-oracle.mjs --receipt /tmp/functional-node-oracle-${lane}.json --budget-profile functional-ci -- /bin/bash -euc '`));
  assert.deepEqual([...functional.matchAll(/timeout-minutes: (\d+)/g)].map(match => Number(match[1])), [60, 60]);
  assert.deepEqual(invocations(repository).map(line => line.trim()), ['head', 'push', 'merge'].map(lane =>
    `node paper-core/bin/with-locked-parent-node-oracle.mjs --receipt /tmp/repository-node-oracle-${lane}.json -- /bin/bash -euc '`));
  for (const lane of ['head', 'push', 'merge']) {
    const cli = budgetHarness({ argv: ['--receipt', `/tmp/repository-node-oracle-${lane}.json`, '--', '/bin/bash', '-euc', 'verification'] });
    assert.deepEqual(cli.calls.map(call => call.options.timeout), [1800000, 1800000, 1800000]);
  }
  const bytes = Buffer.from(functional);
  const blob = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const sha256 = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
  const producers = JSON.parse(read('docs/rust/qualification/source-check-producers.v1.json')).producers
    .filter(producer => producer.workflowPath === functionalPath);
  assert.deepEqual(producers.map(producer => producer.context), ['rust-functional-source-exact-head', 'rust-functional-source-prospective-merge']);
  for (const producer of producers) {
    assert.equal(producer.workflowId, 355736976);
    assert.equal(producer.workflowGitBlobSha, blob);
    assert.equal(producer.workflowSha256, sha256);
  }
});
