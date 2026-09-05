import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const gates = [
  ['.github/workflows/ci.yml', 'Run static and architecture gates'],
  ['.github/workflows/exact-head-source-validation.yml', 'Run exact-head static, architecture, and dependency gates'],
];

function runBlock(file, name) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `${file}:${name}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('      - '));
  const step = lines.slice(start, end < 0 ? lines.length : end);
  assert.equal(step.some((line) => line.includes('continue-on-error:')), false);
  const run = step.indexOf('        run: |');
  assert.notEqual(run, -1);
  const body = [];
  for (const line of step.slice(run + 1)) {
    if (!line.trim()) { body.push(''); continue; }
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  assert.equal(body[0], 'set -euo pipefail');
  return body.join('\n');
}

for (const [file, name] of gates) {
  test(`${file} executes schema, static and audit gates and propagates every failure`, (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-static-gate-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const trace = path.join(temporary, 'trace');
    fs.writeFileSync(path.join(temporary, 'python3'), '#!/bin/sh\nprintf "schema\\n" >> "$TRACE"\nexit "$SCHEMA_EXIT"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(temporary, 'npm'), [
      '#!/bin/sh',
      'test "$1" = run || exit 64',
      'printf "%s\\n" "$2" >> "$TRACE"',
      'case "$2" in',
      '  static:check) exit "$STATIC_EXIT" ;;',
      '  security:npm-audit) exit "$AUDIT_EXIT" ;;',
      '  *) exit 64 ;;',
      'esac', '',
    ].join('\n'), { mode: 0o755 });
    for (const [schema, staticCode, audit, expected] of [
      [0, 0, 0, ['schema', 'static:check', 'security:npm-audit']],
      [13, 0, 0, ['schema']],
      [0, 17, 0, ['schema', 'static:check']],
      [0, 0, 19, ['schema', 'static:check', 'security:npm-audit']],
    ]) {
      fs.writeFileSync(trace, '');
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', runBlock(file, name)], {
        cwd: root, encoding: 'utf8', timeout: 5000,
        env: { PATH: `${temporary}:/usr/bin:/bin`, TRACE: trace,
          SCHEMA_EXIT: String(schema), STATIC_EXIT: String(staticCode), AUDIT_EXIT: String(audit) },
      });
      assert.equal(result.status, schema || staticCode || audit, result.stderr);
      assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), expected);
    }
  });
}


test('exact-head impacted logs preserve the test exit and fail on log writer failure', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-impacted-evidence-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporary, 'npm'), '#!/bin/sh\nprintf "fixture-test-output\\n"\nexit "$TEST_EXIT"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(temporary, 'tee'), '#!/bin/sh\n/usr/bin/tee "$@"\nexit "$TEE_EXIT"\n', { mode: 0o755 });
  const script = runBlock('.github/workflows/exact-head-source-validation.yml', 'Run exact-head impacted shard')
    .replaceAll('${{ matrix.shard }}', '2');
  for (const [testExit, teeExit] of [[0, 0], [17, 0], [0, 29], [17, 29]]) {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { PATH: `${temporary}:/usr/bin:/bin`, RUNNER_TEMP: temporary,
        BASE_SHA: 'a'.repeat(40), EXPECTED_HEAD_SHA: 'b'.repeat(40),
        TEST_EXIT: String(testExit), TEE_EXIT: String(teeExit) },
    });
    assert.equal(result.status, teeExit || testExit, result.stderr);
    const evidence = path.join(temporary, 'exact-head-impact-2');
    assert.equal(fs.readFileSync(path.join(evidence, 'tests.exit'), 'utf8'), `${testExit}\n`);
    assert.equal(fs.readFileSync(path.join(evidence, 'tests.tap'), 'utf8'), 'fixture-test-output\n');
  }
});

test('every portable CI consumer verifies the current R closure after pinned public materialization', () => {
  let consumers = 0;
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/exact-head-source-validation.yml']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const blocks = source.split('      - name: Verify and materialize public R source closure\n').slice(1);
    for (const fragment of blocks) {
      const step = fragment.split('\n      - ')[0];
      assert.ok(step.includes('set -euo pipefail'));
      assert.ok(step.includes('python3 docs/rust/tools/test_public_r_source_cas.py'));
      assert.ok(step.includes('python3 docs/rust/tools/materialize-public-r-source-cas.py'));
      assert.ok(step.includes('inspectRuntimeImageBuildInputClosure({'));
      assert.ok(step.includes('definition: AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS.r'));
      assert.ok(step.includes('...RUNTIME_IMAGE_REPRODUCIBILITY_CANONICAL_BUILD'));
      assert.ok(step.includes('gitlinkCommitVerified: false'));
      assert.ok(step.includes('qualificationClaimed: false'));
      assert.equal(step.includes('continue-on-error'), false);
      consumers += 1;
    }
  }
  assert.equal(consumers, 4);
});
