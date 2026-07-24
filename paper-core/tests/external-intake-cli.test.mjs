import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const entrypoint = path.join(workspaceRoot, 'paper-core/bin/generate-external-intake.mjs');

test('external intake help is side-effect free', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-intake-help-'));
  const runtimeRoot = path.join(temporaryRoot, 'runtime');
  const assetRoot = path.join(temporaryRoot, 'assets');
  try {
    const result = spawnSync(process.execPath, [entrypoint, '--help'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
        HEPTA_PAPER_ASSET_ROOT: assetRoot,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Error|unknown_cli_option/);
    assert.match(result.stdout, /Generates external authority/);
    assert.equal(fs.existsSync(runtimeRoot), false);
    assert.equal(fs.existsSync(assetRoot), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('external intake rejects unknown CLI options without writes', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-intake-cli-'));
  const runtimeRoot = path.join(temporaryRoot, 'runtime');
  try {
    const result = spawnSync(process.execPath, [entrypoint, '--unknown'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown_cli_option:--unknown/);
    assert.equal(fs.existsSync(runtimeRoot), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
