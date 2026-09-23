import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function runtimeTreeSnapshot(runtimeRoot) {
  const snapshot = [];
  const visit = (candidate) => {
    const identity = fs.lstatSync(candidate, { bigint: true });
    snapshot.push(Object.freeze({
      relativePath: path.relative(runtimeRoot, candidate) || '.',
      mode: String(identity.mode),
      size: String(identity.size),
      modifiedNs: String(identity.mtimeNs),
      changedNs: String(identity.ctimeNs),
      contentHash: identity.isFile()
        ? crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')
        : null,
    }));
    if (!identity.isDirectory()) return;
    for (const name of fs.readdirSync(candidate).sort()) {
      visit(path.join(candidate, name));
    }
  };
  visit(runtimeRoot);
  return snapshot;
}

test('maintenance help is zero-write and composition-free through canonical and symlink entries',
  (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-maintenance-help-symlink-'));
    const runtimeRoot = path.join(parent, 'runtime');
    const linkRoot = path.join(parent, 'entrypoints');
    fs.mkdirSync(path.join(runtimeRoot, 'sentinel'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(linkRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(runtimeRoot, 'sentinel', 'unchanged.txt'), 'unchanged\n', {
      mode: 0o600,
    });
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

    const blockingLoader = `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('paper-composition/')) {
    throw new Error('composition_loaded_during_help');
  }
  return nextResolve(specifier, context);
}
`)}`;
    const before = runtimeTreeSnapshot(runtimeRoot);
    const commands = [
      ['autonomous-research-state-provision.mjs',
        /external machine-intake genesis authority/u],
      ['autonomous-research-online-schema-transition.mjs',
        /Plan never creates transition/u],
    ];

    for (const [filename, expectedHelp] of commands) {
      const canonicalEntrypoint = path.join(repositoryRoot, 'paper-core', 'bin', filename);
      const symlinkEntrypoint = path.join(linkRoot, filename);
      fs.symlinkSync(canonicalEntrypoint, symlinkEntrypoint);
      for (const entrypoint of [canonicalEntrypoint, symlinkEntrypoint]) {
        const result = spawnSync(process.execPath, [
          '--no-warnings',
          '--experimental-loader', blockingLoader,
          entrypoint,
          '--help', '--runtime-root', runtimeRoot,
        ], {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot },
          timeout: 30000,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(result.stderr, '');
        assert.match(result.stdout, expectedHelp);
        assert.deepEqual(runtimeTreeSnapshot(runtimeRoot), before, entrypoint);
      }
    }
  });
