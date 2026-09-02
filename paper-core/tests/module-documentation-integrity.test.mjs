import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateModuleDocumentation } from '../../docs/tools/validate-module-documentation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

function copyFile(sourceRoot, targetRoot, relative) {
  const source = path.join(sourceRoot, relative);
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-module-docs-'));
  const registryPath = 'docs/system/truth/modules.v1.json';
  const indexPath = 'docs/modules/module-documentation.v1.json';
  copyFile(ROOT, root, registryPath);
  copyFile(ROOT, root, indexPath);
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, registryPath), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, indexPath), 'utf8'));
  for (const [moduleId, entry] of Object.entries(index.modules)) {
    copyFile(ROOT, root, entry.specPath);
    copyFile(ROOT, root, entry.manifestPath);
    for (const configuredPath of registry.modules[moduleId].paths) {
      const target = path.join(root, configuredPath);
      if (path.extname(configuredPath)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'fixture\n');
      } else {
        fs.mkdirSync(target, { recursive: true });
      }
    }
  }
  return root;
}

test('live repository has complete one-to-one module documentation', () => {
  const result = validateModuleDocumentation({ root: ROOT });
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.report.registryModules, 32);
  assert.equal(result.report.specifications, 32);
  assert.equal(result.report.manifests, 32);
});

test('missing required section fails closed', () => {
  const root = createFixture();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(root, 'docs/modules/module-documentation.v1.json'), 'utf8'));
    const entry = index.modules['module.submission-port'];
    const spec = fs.readFileSync(path.join(root, entry.specPath), 'utf8').replace('## Failure, recovery, and idempotency', '## Removed failure section');
    fs.writeFileSync(path.join(root, entry.specPath), spec);
    const result = validateModuleDocumentation({ root });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /missing heading/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authority-specific safety language and registry parity fail closed', () => {
  const root = createFixture();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(root, 'docs/modules/module-documentation.v1.json'), 'utf8'));
    const entry = index.modules['module.commit-sequencer'];
    const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.manifestPath), 'utf8'));
    manifest.authorityClass = 'read_only';
    fs.writeFileSync(path.join(root, entry.manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
    const result = validateModuleDocumentation({ root });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /authorityClass mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
