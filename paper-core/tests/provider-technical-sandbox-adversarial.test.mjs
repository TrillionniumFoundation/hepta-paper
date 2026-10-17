import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../../provider-sandbox/provider-sandbox.mjs', import.meta.url));
const digest = `sha256:${'a'.repeat(64)}`;

function executeRaw(t, raw, setup = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-technical-adversarial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'request.json');
  const output = path.join(root, 'response.json');
  if (setup) setup({ root, input, output });
  else fs.writeFileSync(input, raw, { mode: 0o600, flag: 'wx' });
  const result = spawnSync(process.execPath, [entry, input, output], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
  return { root, input, output, result };
}

const fields = `"environment":"provider_sandbox","provider":"technical-sandbox",` +
  `"accountId":"no-authority","paperId":"control",` +
  `"dispatchAuthorizationHash":"${digest}","packageHash":"${digest}"`;

test('duplicate live-action key cannot be hidden by its final false value', (t) => {
  const selected = executeRaw(t, `{${fields},"liveActionAllowed":true,"liveActionAllowed":false}`);
  assert.notEqual(selected.result.status, 0);
  assert.match(selected.result.stderr, /request_duplicate_key/u);
  assert.equal(fs.existsSync(selected.output), false);
});

test('escaped duplicate keys are rejected after JSON decoding', (t) => {
  const selected = executeRaw(t,
    `{${fields},"liveActionAllowed":false,"provid\\u0065r":"other"}`);
  assert.notEqual(selected.result.status, 0);
  assert.match(selected.result.stderr, /request_duplicate_key/u);
  assert.equal(fs.existsSync(selected.output), false);
});

test('request structure depth and token count are bounded before field use', (t) => {
  for (const raw of [
    `[${'['.repeat(32)}0${']'.repeat(32)}]`,
    `[${Array(5000).fill('0').join(',')}]`,
  ]) {
    const selected = executeRaw(t, raw);
    assert.notEqual(selected.result.status, 0);
    assert.match(selected.result.stderr, /request_structure_limit|request_invalid/u);
    assert.equal(fs.existsSync(selected.output), false);
  }
});

test('request symlink is a typed denial and target bytes remain untouched', (t) => {
  let target;
  const selected = executeRaw(t, '', ({ root, input }) => {
    target = path.join(root, 'target.json');
    fs.writeFileSync(target, `{${fields},"liveActionAllowed":false}`);
    fs.symlinkSync(target, input);
  });
  assert.notEqual(selected.result.status, 0);
  assert.match(selected.result.stderr, /request_unsafe/u);
  assert.equal(fs.readFileSync(target, 'utf8'), `{${fields},"liveActionAllowed":false}`);
  assert.equal(fs.existsSync(selected.output), false);
});

test('symlinked runtime parent is rejected before request consumption', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-technical-parent-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const real = path.join(parent, 'real');
  const alias = path.join(parent, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias);
  const input = path.join(alias, 'request.json');
  const output = path.join(alias, 'response.json');
  fs.writeFileSync(path.join(real, 'request.json'), `{${fields},"liveActionAllowed":false}`);
  const result = spawnSync(process.execPath, [entry, input, output], {
    encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /path_boundary_invalid/u);
  assert.equal(fs.existsSync(path.join(real, 'response.json')), false);
});
