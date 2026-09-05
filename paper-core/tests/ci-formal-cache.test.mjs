import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildStrictNpmAuditInvocation } from '../../paper-adapters/runtime/strict-npm-audit-launcher.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const executable = 'paper-core/bin/prepare-ci-mathlib-cache.mjs';

test('CI Mathlib cache help discloses source authority and qualification boundary', () => {
  const result = spawnSync(process.execPath, [executable, '--help'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    kind: 'CiMathlibCacheUsage',
    usage: 'prepare-ci-mathlib-cache [--root PATH] [--prepare]',
    sourceAuthority: 'official_pinned_mathlib_commit_and_tree',
    productionAuthorityGranted: false,
  });
});

test('CI Mathlib cache status fails closed when no verified cache exists', (t) => {
  const cache = path.join(root, '.ci-cache', `missing-mathlib-${process.pid}`);
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [executable, '--root', cache], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'ci_mathlib_cache_blocked');
  assert.equal(receipt.productionAuthorityGranted, false);
  assert.ok(receipt.blockers.length > 0);
});

test('CI Mathlib cache refuses deletion targets outside the workspace cache root', () => {
  const result = spawnSync(process.execPath, [
    executable,
    '--root',
    path.join(root, 'paper-core'),
    '--prepare',
  ], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ci_mathlib_cache_root_outside_workspace_cache/);
});


test('CI selects the installed canonical Node without replacing the pinned npm path', () => {
  for (const relative of ['.github/workflows/ci.yml', '.github/workflows/exact-head-source-validation.yml']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const installs = [...source.matchAll(/sudo install -o root -g root -m 0555 "\$strict_node_source" \/usr\/bin\/node/g)];
    assert.ok(installs.length > 0, relative);
    for (const install of installs) {
      const nextStep = source.indexOf('\n      - ', install.index);
      const block = source.slice(install.index, nextStep === -1 ? source.length : nextStep);
      assert.ok(block.includes('strict_node_path="$(mktemp -d "$RUNNER_TEMP/hepta-pinned-node.XXXXXX")"'));
      assert.ok(block.includes('ln -s /usr/bin/node "$strict_node_path/node"'));
      assert.ok(block.includes('echo "$strict_node_path" >> "$GITHUB_PATH"'));
      assert.equal(block.includes('echo /usr/bin >> "$GITHUB_PATH"'), false);
    }
  }
});


test('CI audit restores its same-installation Node/npm pair only for the audit command', () => {
  let calls = 0;
  for (const relative of ['.github/workflows/ci.yml', '.github/workflows/exact-head-source-validation.yml']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const line of source.split('\n').filter((value) => value.includes('npm run security:npm-audit'))) {
      assert.equal(line.trim(), 'PATH="$(dirname "$(command -v npm)"):$PATH" npm run security:npm-audit', relative);
      calls += 1;
    }
    assert.equal(source.includes('export PATH="$(dirname "$(command -v npm)")'), false);
  }
  assert.equal(calls, 4);
});


test('canonical worker Node cannot be mixed with tool-cache npm during audit', () => {
  const npmExecPath = `/opt/hostedtoolcache/node/${process.versions.node}/${process.arch}/lib/node_modules/npm/bin/npm-cli.js`;
  let inspections = 0;
  assert.throws(() => buildStrictNpmAuditInvocation({
    workspaceRoot: fs.realpathSync(root),
    nodeExecPath: '/usr/bin/node',
    npmExecPath,
    environment: {
      CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux',
      RUNNER_TOOL_CACHE: '/opt/hostedtoolcache',
      AGENT_TOOLSDIRECTORY: '/opt/hostedtoolcache',
    },
    executableInspector() { inspections += 1; return {}; },
  }), /strict_npm_audit_executable_not_approved/u);
  assert.equal(inspections, 0);
});
