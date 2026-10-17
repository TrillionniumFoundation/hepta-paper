import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(root, env = process.env) {
  return spawnSync(process.execPath, [
    path.join(repositoryRoot, 'docs/tools/validate-development-docs.mjs'),
    '--root', root,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env },
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function expectFailure(root, pattern) {
  const result = run(root);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

function mutateJson(root, relativePath, mutate, expected) {
  const file = path.join(root, relativePath);
  const original = fs.readFileSync(file, 'utf8');
  const value = JSON.parse(original);
  mutate(value);
  writeJson(file, value);
  try {
    expectFailure(root, expected);
  } finally {
    fs.writeFileSync(file, original);
  }
}

test('development documentation validator fails closed under hostile graph, link, and consumer mutations', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-doc-governance-'));
  const worktree = path.join(temporaryRoot, 'worktree');
  const added = spawnSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(added.status, 0, added.stderr);

  try {
    const baseline = run(worktree);
    assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);

    // Every schema still runs through the strict validator after process batching.
    for (const name of [
      'program-v2', 'capabilities-v1', 'modules-v1', 'work-items-v2',
      'milestones-v1', 'risks-v2', 'canonical-workloads-v1',
      'document-manifest-v1', 'evidence-bindings-v1',
    ]) {
      const schema = path.join(worktree, `docs/system/schemas/${name}.schema.json`);
      const original = fs.readFileSync(schema);
      try {
        fs.writeFileSync(schema, '{"type":"object","unsupportedAssertion":true}');
        expectFailure(worktree, /unsupported.*keyword|unsupportedAssertion/u);
      } finally { fs.writeFileSync(schema, original); }
    }
    const program = path.join(worktree, 'docs/system/truth/program.v2.json');
    const originalProgram = fs.readFileSync(program);
    try {
      fs.writeFileSync(program, '{"kind":"one","kind":"two"}');
      expectFailure(worktree, /duplicate JSON property/u);
      fs.writeFileSync(program, '{"number":1e999}');
      expectFailure(worktree, /non-finite JSON number/u);
      fs.writeFileSync(program, Buffer.from([0xff]));
      expectFailure(worktree, /encoded data.*not valid/u);
    } finally { fs.writeFileSync(program, originalProgram); }

    for (const relative of [
      'docs/system/truth/program.v2.json',
      'docs/system/schemas/program-v2.schema.json',
    ]) {
      const file = path.join(worktree, relative);
      const original = fs.readFileSync(file);
      try {
        fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]));
        expectFailure(worktree, /Unexpected token|BOM|schema:/u);
        fs.writeFileSync(file, Buffer.concat([Buffer.from('{"description":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
        expectFailure(worktree, /encoded data.*not valid/u);
      } finally { fs.writeFileSync(file, original); }
    }

    const shimRoot = path.join(temporaryRoot, 'python-shim');
    fs.mkdirSync(shimRoot);
    const shim = path.join(shimRoot, 'python3');
    for (const [output, status] of [
      ['not-json', 0], ['{}', 0], ['{"ok":true,"failures":[]}', 9],
      ['{"ok":false,"failures":[]}', 0],
    ]) {
      fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${status}\n`, { mode: 0o755 });
      const result = run(worktree, { ...process.env, PATH: `${shimRoot}:${process.env.PATH}` });
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /schema validation unavailable or invalid/u);
    }

    const brokenLink = path.join(worktree, 'docs/system/HOSTILE_LINK.md');
    fs.writeFileSync(brokenLink, '# Hostile link\n\n[missing](./DOES_NOT_EXIST.md)\n');
    try {
      expectFailure(worktree, /missing local link (?:\.\/)?DOES_NOT_EXIST\.md/);
    } finally {
      fs.rmSync(brokenLink, { force: true });
    }

    const hostileWorkflow = path.join(worktree, '.github/workflows/hostile-document-reference.yml');
    const staleReference = 'docs/rust/qualification/PLAN_V3_EXTERNAL_GAP_EXECUTION.md';
    fs.writeFileSync(hostileWorkflow, `name: hostile\n# ${staleReference}\n`);
    try {
      expectFailure(worktree, /forbidden historical document reference/);

      const manifestPath = path.join(worktree, 'docs/system/truth/document-manifest.v1.json');
      const originalManifest = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(originalManifest);
      manifest.referenceAllowlist.push({
        consumerPath: '.github/workflows/hostile-document-reference.yml',
        reference: staleReference,
        reason: 'hostile fixture proves an exact historical-reference exception',
      });
      writeJson(manifestPath, manifest);
      const allowed = run(worktree);
      assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);

      manifest.referenceAllowlist[0].consumerPath = '.github/workflows/different-consumer.yml';
      writeJson(manifestPath, manifest);
      expectFailure(worktree, /unused reference allowlist entry|forbidden historical document reference/);
      fs.writeFileSync(manifestPath, originalManifest);
    } finally {
      fs.rmSync(hostileWorkflow, { force: true });
    }

    mutateJson(
      worktree,
      'docs/system/truth/capabilities.v1.json',
      (truth) => {
        const [left, right] = Object.keys(truth.capabilities).sort();
        truth.capabilities[left].dependencies = [right];
        truth.capabilities[right].dependencies = [left];
      },
      /capability cycle/,
    );
    mutateJson(
      worktree,
      'docs/system/truth/modules.v1.json',
      (truth) => {
        const [left, right] = Object.keys(truth.modules).sort();
        truth.modules[left].dependencies = [right];
        truth.modules[right].dependencies = [left];
      },
      /module cycle/,
    );
    mutateJson(
      worktree,
      'docs/system/truth/work-items.v2.json',
      (truth) => {
        const [left, right] = Object.keys(truth.items).sort();
        truth.items[left].dependencies = [right];
        truth.items[right].dependencies = [left];
      },
      /work-item cycle/,
    );
    mutateJson(
      worktree,
      'docs/system/truth/milestones.v1.json',
      (truth) => {
        truth.milestones.G0.dependencies = ['G1'];
        truth.milestones.G1.dependencies = ['G0'];
      },
      /milestone cycle/,
    );
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
