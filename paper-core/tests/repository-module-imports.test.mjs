import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const productionRoots = ['workflow-kernel', 'paper-ports', 'paper-domain', 'paper-application', 'paper-adapters', 'paper-core/src'];
const excluded = new Set([
  'paper-core/src/authority-pipeline-selftest.mjs',
  'paper-core/src/remediation-selftest.mjs',
  'paper-core/src/selftest.mjs',
]);

function modulesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return modulesUnder(absolute);
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) return [];
    return [path.relative(workspaceRoot, absolute).replace(/\\/g, '/')];
  });
}

test('every production module is importable and participates in repository coverage', async () => {
  const modules = productionRoots.flatMap((root) => modulesUnder(path.join(workspaceRoot, root)))
    .filter((relative) => !excluded.has(relative))
    .sort();
  assert.ok(modules.length >= 90, `unexpected production inventory: ${modules.length}`);
  const failures = [];
  for (const relative of modules) {
    try { await import(pathToFileURL(path.join(workspaceRoot, relative)).href); }
    catch (error) { failures.push({ relative, error: error?.stack || error?.message || String(error) }); }
  }
  assert.deepEqual(failures, []);
  assert.equal(new Set(modules).size, modules.length);
});
