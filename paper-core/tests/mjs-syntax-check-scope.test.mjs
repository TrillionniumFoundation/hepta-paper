import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverMjsModuleFiles } from '../bin/check-mjs-syntax.mjs';

test('syntax discovery excludes only root runtime state and keeps source runtime namespaces', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-syntax-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'paper-adapters', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', 'generated.mjs'), 'export const ignored = true;\n');
  fs.writeFileSync(path.join(root, 'paper-adapters', 'runtime', 'source.mjs'),
    'export const checked = true;\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'fixture', 'dependency.mjs'),
    'export const ignored = true;\n');

  assert.deepEqual(discoverMjsModuleFiles(root), [
    path.join(root, 'paper-adapters', 'runtime', 'source.mjs'),
  ]);
});
