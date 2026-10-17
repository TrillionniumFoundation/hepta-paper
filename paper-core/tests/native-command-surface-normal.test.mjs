import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { buildNativeOwners, safeEnvironment } from '../../docs/tools/node-rust-route-acceptance.mjs';

// These actual normal-entry comparisons do not accept the entire route's
// recovery domain. Interrupted mutation is verified separately. Native atomic
// publication changes the package inode; Node truncates its existing inode.
// Native also retains an explicit, non-authoritative recovery namespace under
// the external runtime. Those additional effects and safety refusals keep this
// route partial even when normal package bytes and inspection output match.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const identity = value => [value.dev, value.ino, value.mode, value.uid, value.gid, value.nlink,
  value.size, value.mtimeNs, value.ctimeNs].map(String);
let fixture, binarySource, binarySourcePin, deployments, caller, graph;
function pin(file) {
  const before = fs.lstatSync(file, { bigint: true });
  assert.ok(before.isFile()); assert.ok(before.size <= 512n * 1024n * 1024n, 'pinned artifact cap exceeded');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const held = fs.fstatSync(fd, { bigint: true }), hash = createHash('sha256'), block = Buffer.alloc(64 * 1024);
    let total = 0n;
    for (let n; (n = fs.readSync(fd, block)) !== 0;) {
      total += BigInt(n); assert.ok(total <= before.size, 'pinned file grew while reading');
      hash.update(block.subarray(0, n));
    }
    assert.equal(total, before.size, 'pinned file shortened while reading');
    for (const value of [held, fs.fstatSync(fd, { bigint: true }), fs.lstatSync(file, { bigint: true })]) assert.deepEqual(identity(value), identity(before));
    return { identity: identity(before), sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function copy(from, to, mode = 0o440) {
  const before = pin(from); fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, mode);
  assert.equal(pin(to).sha256, before.sha256); assert.deepEqual(pin(from), before);
  return pin(to);
}
function environment() {
  const env = safeEnvironment();
  return { ...env, PATH: `${path.dirname(process.execPath)}:${env.PATH || '/usr/bin:/bin'}`,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
}
function run(engine, extra = [], executable) {
  const root = deployments[engine];
  const program = engine === 'node' ? process.execPath : executable || path.join(root, 'bin/hepta-paper-rust');
  const args = ['maintenance', 'command-surface-sync', ...extra];
  const output = spawnSync(program, engine === 'node' ? [path.join(root, 'paper-core/bin/hepta-paper.mjs'), ...args] : args,
    { cwd: caller, env: environment(), encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(output.error, undefined, output.error?.message); assert.equal(output.signal, null, output.stderr);
  return output;
}
function seed(value) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value);
  for (const root of Object.values(deployments)) {
    const file = path.join(root, 'package.json'); fs.writeFileSync(file, bytes); fs.chmodSync(file, 0o640);
  }
}
function settledExternalRuntime(root) {
  assert.equal(fs.existsSync(path.join(root, '.hepta-command-surface-publication-v1')), false);
  const namespace = path.join(path.dirname(root), 'hepta-paper-runtime/native-runtime/command-surface-publication-v2');
  const matches = fs.readdirSync(namespace).filter(name => {
    const file = path.join(namespace, name, 'root-binding-v2.json');
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).workspace_path === root;
  });
  assert.equal(matches.length, 1);
  const selected = path.join(namespace, matches[0]);
  assert.equal(fs.statSync(selected).mode & 0o7777, 0o700);
  assert.deepEqual(fs.readdirSync(selected).sort(), ['lock', 'root-binding-v2.json']);
  const binding = path.join(selected, 'root-binding-v2.json'), lock = path.join(selected, 'lock');
  for (const file of [binding, lock]) {
    const metadata = fs.lstatSync(file); assert.ok(metadata.isFile());
    assert.equal(metadata.nlink, 1); assert.equal(metadata.uid, process.getuid());
    assert.equal(metadata.mode & 0o7777, 0o600);
  }
  const value = JSON.parse(fs.readFileSync(binding, 'utf8'));
  assert.equal(value.version, 2); assert.equal(value.authority_granted, false);
  assert.equal(value.kind, 'OrdinaryPackagePublicationRootBinding');
  assert.equal(value.workspace_path, root);
  assert.equal(value.runtime_path, path.dirname(namespace));
  return selected;
}
function packageValue(scripts) {
  return { name: 'hepta-paper-workspace', version: '0.21.0', integer: 1, zero: -0, large: 1e21,
    small: 1e-7, scripts, customMetadata: { retained: 'actual-local-write' } };
}
before(() => {
  const runtime = buildNativeOwners(); binarySource = runtime.owners['hepta-paper-rust'].path;
  binarySourcePin = pin(binarySource); assert.equal(`sha256:${binarySourcePin.sha256}`, runtime.owners['hepta-paper-rust'].sha256);
  fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.userInfo().homedir), '.hepta-command-surface-normal-'));
  caller = path.join(fixture, 'caller'); fs.mkdirSync(caller);
  fs.writeFileSync(path.join(caller, 'package.json'), JSON.stringify(packageValue({ callerOnly: 'must remain untouched' })));
  deployments = Object.fromEntries(['node', 'native'].map(engine => [engine, path.join(fixture, engine)]));
  graph = new Map(); const pending = ['paper-core/bin/hepta-paper.mjs', 'paper-core/bin/command-surface.mjs'];
  while (pending.length) {
    const relative = pending.pop(); if (graph.has(relative)) continue;
    const from = path.join(source, relative), copies = {};
    for (const [engine, root] of Object.entries(deployments)) copies[engine] = copy(from, path.join(root, relative));
    graph.set(relative, { source: pin(from), copies });
    for (const match of fs.readFileSync(from, 'utf8').matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const specifier = match[1]; if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `unbound import: ${specifier}`);
      const selected = path.relative(source, path.resolve(path.dirname(from), specifier));
      assert.ok(selected && !selected.startsWith(`..${path.sep}`) && !path.isAbsolute(selected)); pending.push(selected);
    }
  }
  for (const root of Object.values(deployments)) fs.mkdirSync(path.join(root, 'paper-core/config'), { recursive: true });
  copy(binarySource, path.join(deployments.native, 'bin/hepta-paper-rust'), 0o550);
});
after(() => {
  if (!fixture) return;
  try {
    assert.deepEqual(pin(binarySource), binarySourcePin);
    for (const [relative, observation] of graph) {
      assert.deepEqual(pin(path.join(source, relative)), observation.source);
      for (const [engine, root] of Object.entries(deployments)) assert.deepEqual(pin(path.join(root, relative)), observation.copies[engine]);
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('normal_sync_compares_actual_node_output_package_bytes_and_persisted_inode_permissions_then_retries', () => {
  const callerBefore = pin(path.join(caller, 'package.json'));
  for (const scripts of [undefined, {}, { test: 'old', 'store:status': 'old', 'gpu:personal-gate': 0 },
    { custom: 'echo unknown', '\ue000-unknown': 'bmp', '😀-unknown': 'astral' }, ['first', 'second'], 'a😀b', 1, false, null]) {
    seed(packageValue(scripts));
    const before = Object.fromEntries(Object.entries(deployments).map(([engine, root]) => [engine, pin(path.join(root, 'package.json'))]));
    const node = run('node'), native = run('native');
    assert.equal(native.status, node.status, native.stderr); assert.equal(native.stdout, node.stdout);
    assert.ok(native.stdout.startsWith('{')); assert.equal(native.stderr, '');
    const expected = fs.readFileSync(path.join(deployments.node, 'package.json'));
    assert.deepEqual(fs.readFileSync(path.join(deployments.native, 'package.json')), expected);
    for (const [engine, root] of Object.entries(deployments)) {
      const current = pin(path.join(root, 'package.json'));
      assert.equal(current.identity[0], before[engine].identity[0]);
      assert.deepEqual(current.identity.slice(2, 6), before[engine].identity.slice(2, 6));
      if (engine === 'node') assert.equal(current.identity[1], before[engine].identity[1]);
      else assert.notEqual(current.identity[1], before[engine].identity[1]);
      const retry = run(engine, ['--']); assert.equal(retry.status, node.status); assert.equal(retry.stdout, node.stdout);
      assert.deepEqual(fs.readFileSync(path.join(root, 'package.json')), expected);
    }
  }
  assert.deepEqual(pin(path.join(caller, 'package.json')), callerBefore);
  settledExternalRuntime(deployments.native);
  assert.equal(fs.existsSync(path.join(deployments.node, '.hepta-command-surface-publication-v1')), false);
});
test('normal_sync_rejects_registry_forwarding_before_package_mutation_and_retains_fresh_retry', () => {
  for (const extra of [['unexpected'], ['--write-package'], ['--', 'unexpected'], ['--', '--help'], ['--', '--'], ['--', '']]) {
    seed(packageValue({ test: 'old' }));
    const before = Object.fromEntries(Object.entries(deployments).map(([engine, root]) => [engine, pin(path.join(root, 'package.json'))]));
    const node = run('node', extra), native = run('native', extra);
    assert.equal(node.status, 2, node.stderr); assert.equal(native.status, 2, native.stderr);
    assert.equal(node.stdout, ''); assert.equal(native.stdout, '');
    assert.ok(native.stderr.includes(JSON.parse(node.stderr).error));
    for (const [engine, root] of Object.entries(deployments)) assert.deepEqual(pin(path.join(root, 'package.json')), before[engine]);
    const retryNode = run('node'), retryNative = run('native'); assert.equal(retryNative.status, retryNode.status); assert.equal(retryNative.stdout, retryNode.stdout);
  }
});
test('normal_sync_refuses_hardlinked_deployment_marker_and_unknown_copy_before_writes_then_retries', () => {
  seed(packageValue({ test: 'old' }));
  const root = deployments.native, file = path.join(root, 'package.json'), alias = path.join(root, 'package-alias.json');
  fs.linkSync(file, alias); const linked = pin(file);
  const rejected = run('native'); assert.equal(rejected.status, 1); assert.equal(rejected.stdout, ''); assert.match(rejected.stderr, /native_workspace_root_required/u);
  assert.deepEqual(pin(file), linked); assert.deepEqual(fs.readFileSync(alias), fs.readFileSync(file));
  fs.unlinkSync(alias);
  const node = run('node'), native = run('native'); assert.equal(native.status, node.status); assert.equal(native.stdout, node.stdout);
  const unknown = path.join(fixture, 'unknown/debug/hepta-paper-rust'); copy(binarySource, unknown, 0o550);
  const before = pin(file);
  const refused = run('native', [], unknown); assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.match(refused.stderr, /native_workspace_root_required/u);
  assert.deepEqual(pin(file), before);
});
test('normal_sync_keeps_actual_string_expansion_above_64k_readable_on_fresh_retry', () => {
  seed(packageValue('x'.repeat(10_000)));
  const node = run('node'), native = run('native');
  assert.equal(native.status, node.status, native.stderr); assert.equal(native.stdout, node.stdout);
  const expected = fs.readFileSync(path.join(deployments.node, 'package.json'));
  assert.ok(expected.length > 64 * 1024); assert.deepEqual(fs.readFileSync(path.join(deployments.native, 'package.json')), expected);
  const retryNode = run('node'), retryNative = run('native');
  assert.equal(retryNative.status, retryNode.status, retryNative.stderr); assert.equal(retryNative.stdout, retryNode.stdout);
  assert.deepEqual(fs.readFileSync(path.join(deployments.native, 'package.json')), expected);
});

// This actual normal entry uses an explicit native relocation ROOT, because
// placing a large ELF inside selected source would itself alter that subject.
// The Git fixture selects the actual copied normal graph/documents and exact
// unmaterialized gitlink references; it is neither H/M nor release acceptance.
test('normal_sync_external_runtime_preserves_clean_selected_source_for_actual_release_bootstrap', () => {
  const root = path.join(fixture, 'source-bootstrap'); fs.mkdirSync(root, { mode: 0o775 });
  for (const relative of graph.keys()) copy(path.join(source, relative), path.join(root, relative));
  fs.mkdirSync(path.join(root, 'paper-core/config'), { recursive: true });
  for (const relative of ['package.json', 'package-lock.json', 'paper-core/docs/CURRENT_STATUS.md',
    'RELEASE.md', 'CHANGELOG.md', '.gitignore', '.gitmodules']) {
    copy(path.join(source, relative), path.join(root, relative), 0o640);
  }
  const invoke = (program, args, extraEnv = {}) => {
    const output = spawnSync(program, args, { cwd: root,
      env: { ...environment(), ...extraEnv }, encoding: 'utf8', shell: false,
      timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(output.error, undefined, output.error?.message); assert.equal(output.signal, null);
    return output;
  };
  const git = (...args) => {
    const output = invoke('/usr/bin/git', args);
    assert.equal(output.status, 0, output.stderr); return output.stdout;
  };
  git('init', '--quiet'); git('add', '--all');
  for (const [relative, commit] of [['core', 'ff1779d38561e940e5e067006386ff00d8d09a7c'],
    ['runtime-images/r-scientific/source-cas', 'd13d857909525f4173063dbd6a7f1f48a089ae93']]) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
    git('update-index', '--add', '--cacheinfo', `160000,${commit},${relative}`);
  }
  const commit = () => git('-c', 'user.name=Owned publication fixture', '-c',
    'user.email=fixture@invalid.example', 'commit', '--quiet', '--no-gpg-sign', '-m', 'owned selected source');
  commit(); assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '');
  const native = invoke(binarySource, ['maintenance', 'command-surface-sync'],
    { HEPTA_PAPER_WORKSPACE_ROOT: root });
  assert.ok([0, 1].includes(native.status), native.stderr); assert.equal(native.stderr, '');
  assert.ok(native.stdout.startsWith('{')); settledExternalRuntime(root);
  const changes = git('status', '--porcelain=v1', '--untracked-files=all').trim();
  assert.ok(changes === '' || changes === 'M package.json', changes);
  if (changes) { git('add', 'package.json'); commit(); }
  const selected = git('rev-parse', 'HEAD').trim();
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '');
  const bootstrap = invoke(binarySource, ['maintenance', 'release-attest'],
    { HEPTA_PAPER_WORKSPACE_ROOT: root });
  assert.equal(bootstrap.status, 1); assert.equal(bootstrap.stdout, '');
  // This downstream refusal is reached only after the actual existing owner
  // has checked clean selected/index/raw source, full fsck and fixed snapshots.
  assert.match(bootstrap.stderr, /workspace_release_state_not_ready:/u);
  assert.doesNotMatch(bootstrap.stderr, /bootstrap_source_changed_or_dirty|source_.*failed/u);
  assert.equal(git('rev-parse', 'HEAD').trim(), selected);
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '');
  settledExternalRuntime(root);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'hepta-paper-runtime/native-runtime/signing')), false);
});
