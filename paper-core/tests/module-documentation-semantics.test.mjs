import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateModuleDocumentation, validateProseStateClaims, validateProseAuthorityClaims } from '../../docs/tools/validate-module-documentation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WRITER_SPEC = 'docs/modules/specs/commit-sequencer.md';

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
  for (const relative of [
    'docs/system/truth/work-items.v2.json',
    'docs/system/schemas/modules-v1.schema.json',
    'docs/system/schemas/work-items-v2.schema.json',
    'docs/modules/schemas/module-documentation-index-v1.schema.json',
    'docs/modules/schemas/module-documentation-manifest-v1.schema.json',
  ]) copyFile(ROOT, root, relative);
  return root;
}

test('prose static-state checker rejects wrapped, repeated and qualified overclaims', () => {
  const record = { state: 'source_implemented' };
  for (const text of [
    'The static state remains `design_ready`.',
    'The static module\nstate therefore remains `design_ready` pending review.',
    'Static module state and CTL-002 remain\n`design_ready` until acceptance.',
    'The static implementation state is `source_qualified`.',
    'staticImplementationState: target_host_qualified',
  ]) {
    assert.equal(validateProseStateClaims('module.example', record, text).length, 1, text);
  }
  assert.deepEqual(validateProseStateClaims('module.example', record,
    'The static module state is `source_implemented`. Effective qualification remains absent.'), []);
  assert.deepEqual(validateProseStateClaims('module.example', record,
    'Another work item remains `design_ready`; no static implementation claim is made.'), []);
});

test('valid identity cannot hide a contradictory state in the specification body', () => {
  const root = createFixture();
  try {
    fs.appendFileSync(path.join(root, WRITER_SPEC), '\n\nThe static module state remains `design_ready`.\n');
    const result = validateModuleDocumentation({ root });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /contradictory prose static state/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('activation and authority claims cannot silently promote a module in prose', () => {
  const record = { activation: 'disabled', authority: 'prepared_result_only' };
  for (const source of [
    'Current static activation: `authoritative`.',
    'Current channel is\n`canary`.',
    'staticActivation: authoritative',
    'Maximum authority class: `central_state_write`.',
    'authorityClass: external_effect',
  ]) {
    assert.equal(validateProseAuthorityClaims('module.example', record, source).length, 1, source);
  }
  assert.deepEqual(validateProseAuthorityClaims('module.example', record,
    'Current static activation: `disabled`.\n\nCurrent channel is `disabled`.\n\nMaximum authority class: `prepared_result_only`.'), []);
  assert.deepEqual(validateProseAuthorityClaims('module.example', record,
    'A future independently qualified version may become authoritative; no current activation is claimed.'), []);
});

test('valid identity cannot hide rollout activation or central-writer overclaims', () => {
  for (const [claim, expected] of [
    ['Current channel is `authoritative`.', /contradictory prose activation/],
    ['Maximum authority class: `external_effect`.', /contradictory prose authority/],
  ]) {
    const root = createFixture();
    try {
      fs.appendFileSync(path.join(root, WRITER_SPEC), `\n\n${claim}\n`);
      const result = validateModuleDocumentation({ root });
      assert.equal(result.ok, false);
      assert.match(result.failures.join('\n'), expected);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
