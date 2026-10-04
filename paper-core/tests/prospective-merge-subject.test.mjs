import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareProspectiveMerge, verifyProspectiveMerge } from '../../docs/tools/prepare-prospective-merge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-prospective-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@invalid.example', ...args], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-24T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-24T00:00:00Z' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q'); fs.writeFileSync(path.join(root, 'initial'), 'original\n');
  git('add', '.'); git('commit', '-qm', 'initial'); const initial = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'base'), 'integration\n');
  git('add', '.'); git('commit', '-qm', 'integration'); const base = git('rev-parse', 'HEAD');
  git('checkout', '--detach', initial);
  fs.writeFileSync(path.join(root, 'target'), 'candidate\n');
  git('add', '.'); git('commit', '-qm', 'candidate'); const target = git('rev-parse', 'HEAD');
  return { root, git, base, target, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function snapshot(f) {
  return { head: f.git('rev-parse', 'HEAD'), refs: f.git('show-ref'),
    status: f.git('status', '--porcelain=v1', '--untracked-files=all'),
    index: fs.readFileSync(path.join(f.root, '.git/index')), files: Object.fromEntries(
      fs.readdirSync(f.root).filter((name) => name !== '.git').map((name) => [name, fs.readFileSync(path.join(f.root, name))])) };
}

test('one prospective identity binds both parents and preserves dirty user state', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'staged'), 'staged data'); f.git('add', 'staged');
    fs.writeFileSync(path.join(f.root, 'initial'), 'uncommitted data');
    fs.writeFileSync(path.join(f.root, 'untracked'), 'untracked data');
    const before = snapshot(f);
    const first = prepareProspectiveMerge(f);
    assert.deepEqual(prepareProspectiveMerge(f), first);
    assert.equal(f.git('show', '-s', '--format=%P', first.commit), `${f.base} ${f.target}`);
    assert.equal(f.git('show', `${first.commit}:base`), 'integration');
    assert.equal(f.git('show', `${first.commit}:target`), 'candidate');
    assert.equal(f.git('show', `${first.commit}:initial`), 'original');
    assert.deepEqual(snapshot(f), before);
    f.git('config', 'commit.gpgsign', 'true');
    f.git('config', 'user.signingkey', 'unavailable-signing-key');
    assert.deepEqual(prepareProspectiveMerge(f), first, 'synthetic local object is not signed branch delivery');
  } finally { f.clean(); }
});

test('CLI ignores inherited Git subject and identity overrides without moving refs', () => {
  const f = fixture();
  try {
    const expected = prepareProspectiveMerge(f);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'docs/tools/prepare-prospective-merge.mjs'),
      '--root', f.root, '--base', f.base, '--target', f.target], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, GIT_DIR: '/nonexistent', GIT_INDEX_FILE: '/nonexistent/index',
        GIT_AUTHOR_NAME: 'Substitution', GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${expected.commit}\n`);
    assert.equal(f.git('rev-parse', 'HEAD'), f.target);
  } finally { f.clean(); }
});

test('observed prospective subject uses the creation recipe and rejects substituted parents tree message or identity', () => {
  const f = fixture();
  try {
    const expected = prepareProspectiveMerge(f);
    assert.throws(() => verifyProspectiveMerge({ ...f, commit: expected.commit }), /checkout_mismatch/u);
    f.git('checkout', '--detach', expected.commit);
    fs.writeFileSync(path.join(f.root, 'initial'), 'preserved observation bytes');
    const before = snapshot(f);
    assert.deepEqual(verifyProspectiveMerge({ ...f, commit: expected.commit }), expected);
    assert.deepEqual(snapshot(f), before);
    f.git('checkout', '--detach', expected.commit);
    const canonicalMessage = `Hepta canonical prospective merge v1\n\nbase ${f.base}\ntarget ${f.target}\n`;
    const cases = [
      [f.git('rev-parse', `${f.target}^{tree}`), ['-p', f.base, '-p', f.target], canonicalMessage],
      [expected.tree, ['-p', f.target, '-p', f.base], canonicalMessage],
      [expected.tree, ['-p', f.target], canonicalMessage],
      [expected.tree, ['-p', f.base, '-p', f.target], 'substituted message'],
      [expected.tree, ['-p', f.base, '-p', f.target], canonicalMessage],
    ];
    for (const [tree, parents, message] of cases) {
      // Fixture identity differs from the canonical observer even when every
      // tree, parent and message byte is otherwise equal.
      const substituted = f.git('commit-tree', tree, ...parents, '-m', message);
      assert.notEqual(substituted, expected.commit);
      f.git('checkout', '--detach', substituted);
      const rejected = snapshot(f);
      assert.throws(() => verifyProspectiveMerge({ ...f, commit: substituted }), /identity_changed/u);
      assert.deepEqual(snapshot(f), rejected);
    }
    assert.throws(() => verifyProspectiveMerge({ ...f, base: f.target, commit: expected.commit }), /merge_identity_invalid/u);
  } finally { f.clean(); }
});

test('invalid inputs unknown commits and wrong checkout fail without touching the index', () => {
  const f = fixture();
  try {
    const before = snapshot(f);
    for (const base of ['HEAD', '--help', f.base.slice(0, 8), '0'.repeat(40)]) {
      assert.throws(() => prepareProspectiveMerge({ ...f, base }), /prospective_subject/);
    }
    assert.throws(() => prepareProspectiveMerge({ ...f, target: f.base }), /checkout_mismatch/);
    assert.deepEqual(snapshot(f), before);
    const alias = prepareProspectiveMerge({ ...f, base: f.target });
    assert.equal(alias.commit, f.target, 'equal-parent push has only one subject');
  } finally { f.clean(); }
});

test('real merge conflicts retain source files refs and index and emit no subject', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'initial'), 'candidate conflict\n');
    f.git('add', '.'); f.git('commit', '-qm', 'candidate conflict'); const target = f.git('rev-parse', 'HEAD');
    f.git('checkout', '--detach', f.base);
    fs.writeFileSync(path.join(f.root, 'initial'), 'integration conflict\n');
    f.git('add', '.'); f.git('commit', '-qm', 'integration conflict'); const base = f.git('rev-parse', 'HEAD');
    f.git('checkout', '--detach', target); const before = snapshot(f);
    assert.throws(() => prepareProspectiveMerge({ ...f, base, target }), /prospective_subject_git_failed:merge-tree/);
    assert.deepEqual(snapshot(f), before);
  } finally { f.clean(); }
});

test('functional repository and product lanes all invoke the same prospective recipe', () => {
  for (const name of ['rust-functional-source-closure', 'repository-source-evidence', 'rust-product-targets']) {
    const text = fs.readFileSync(path.join(ROOT, `.github/workflows/${name}.yml`), 'utf8');
    assert.equal(text.split('node docs/tools/prepare-prospective-merge.mjs').length - 1, 1, name);
    assert.ok(!text.includes('git commit-tree') && !text.includes('git merge-tree'), name);
    assert.ok(text.includes('22.23.1'), `${name} pins the helper runtime`);
  }
});

test('all six dual-subject checks are required and producer-bound, never advisory', () => {
  const required = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/rust/qualification/source-required-checks.v1.json')));
  const producers = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/rust/qualification/source-check-producers.v1.json')));
  for (const context of [
    'source-evidence-exact-head', 'source-evidence-prospective-merge',
    'rust-functional-source-exact-head', 'rust-functional-source-prospective-merge',
    'product-targets (exact-head)', 'product-targets (prospective-merge)',
  ]) {
    assert.ok(required.contexts.includes(context), context);
    assert.equal(producers.producers.filter((row) => row.context === context).length, 1, context);
  }
  assert.equal(required.acceptedConclusion, 'success');
  assert.ok(required.forbiddenConclusions.includes('skipped'));
  assert.equal(required.authority.productionAuthorized, false);
});
