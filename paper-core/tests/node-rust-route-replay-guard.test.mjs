import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { SOURCE_EVIDENCE_PRODUCER_PATHS } from '../../paper-core/src/source-evidence-producer.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { captureOwnRouteReplayGuardV1, assertOwnRouteReplayGuardV1 } from '../../docs/tools/node-rust-route-replay-guard.mjs';
import { buildNativeOwners, safeEnvironment } from '../../docs/tools/node-rust-route-acceptance.mjs';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
function actualParserPackageRoot(name) {
  let selected = path.dirname(fs.realpathSync(require.resolve(name)));
  while (true) {
    const manifest = path.join(selected, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) return selected;
    const parent = path.dirname(selected); assert.notEqual(parent, selected); selected = parent;
  }
}
const refused = /current_inputs_changed|git_command_failed|path_invalid|ENOENT|file_invalid/u;
function git(root, ...args) {
  const output = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(output.status, 0, output.stderr || output.error?.message); return output.stdout.trim();
}
function fixture() {
  // Cargo searches every ancestor. Use an owned NSS-home fixture instead of
  // the shared temporary-directory namespace, whose unrelated entry changes
  // must correctly invalidate an observed missing Cargo configuration edge.
  const directory = fs.mkdtempSync(path.join(os.userInfo().homedir, '.hepta-own-replay-guard-'));
  const root = path.join(directory, 'source'); fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'source.txt'), 'bound source bytes\n', { flag: 'wx', mode: 0o600 });
  git(root, 'init', '--quiet'); git(root, 'add', 'source.txt');
  git(root, '-c', 'user.name=Private Guard Fixture', '-c', 'user.email=guard@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', 'Bound guard source');
  return { directory, root };
}
test('actual_guard_rejects_source_namespace_raw_alias_identity_and_index_changes', () => {
  const { directory, root } = fixture(), environment = safeEnvironment(), input = path.join(root, 'source.txt');
  try {
    fs.utimesSync(input, new Date(0), new Date(1000));
    const original = fs.readFileSync(input), originalMtimeNs = fs.statSync(input, { bigint: true }).mtimeNs, initial = captureOwnRouteReplayGuardV1(root, environment);
    assertOwnRouteReplayGuardV1(initial, root, environment);
    const changed = Buffer.from(original); changed[0] ^= 1; fs.writeFileSync(input, changed);
    fs.utimesSync(input, new Date(0), new Date(1000));
    assert.equal(fs.statSync(input, { bigint: true }).mtimeNs, originalMtimeNs);
    assert.throws(() => assertOwnRouteReplayGuardV1(initial, root, environment), refused);
    fs.writeFileSync(input, original);
    let guard = captureOwnRouteReplayGuardV1(root, environment);
    const replacement = path.join(directory, 'replacement'); fs.writeFileSync(replacement, original, { mode: 0o600 }); fs.renameSync(replacement, input);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    guard = captureOwnRouteReplayGuardV1(root, environment);
    fs.writeFileSync(path.join(root, 'ignored-namespace-input'), 'new bytes');
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    fs.unlinkSync(path.join(root, 'ignored-namespace-input'));
    guard = captureOwnRouteReplayGuardV1(root, environment); fs.renameSync(input, replacement); fs.symlinkSync(replacement, input);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused); fs.unlinkSync(input); fs.renameSync(replacement, input);
    guard = captureOwnRouteReplayGuardV1(root, environment);
    const index = path.join(root, '.git', 'index'), indexBytes = fs.readFileSync(index);
    fs.writeFileSync(index, Buffer.from('invalid actual index'));
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused); fs.writeFileSync(index, indexBytes);
    guard = captureOwnRouteReplayGuardV1(root, environment);
    const head = path.join(root, '.git', 'HEAD'), headBytes = fs.readFileSync(head);
    fs.writeFileSync(replacement, headBytes, { mode: 0o600 }); fs.renameSync(replacement, head);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('actual_guard_rejects_closed_environment_and_same_mtime_tool_bytes', () => {
  const { directory, root } = fixture(), originalPath = process.env.PATH;
  try {
    const bin = path.join(directory, 'bin'); fs.mkdirSync(bin); const tool = path.join(bin, 'git');
    fs.copyFileSync('/usr/bin/git', tool); fs.chmodSync(tool, 0o550); fs.utimesSync(tool, new Date(0), new Date(1000));
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const environment = safeEnvironment(), guard = captureOwnRouteReplayGuardV1(root, environment);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, { ...environment, TZ: 'Etc/GMT+3' }), refused);
    const before = fs.statSync(tool), originalMtimeNs = fs.statSync(tool, { bigint: true }).mtimeNs, bytes = fs.readFileSync(tool); bytes[bytes.length - 1] ^= 1;
    fs.chmodSync(tool, 0o750); fs.writeFileSync(tool, bytes); fs.chmodSync(tool, 0o550); fs.utimesSync(tool, before.atime, before.mtime);
    assert.equal(fs.statSync(tool, { bigint: true }).mtimeNs, originalMtimeNs);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
  } finally { process.env.PATH = originalPath; fs.rmSync(directory, { recursive: true, force: true }); }
});
test('actual_guard_rejects_an_elf_compiled_for_a_different_source_root', () => {
  const { directory, root } = fixture(), environment = safeEnvironment();
  try {
    // A prior actual frontend ELF is an input to this negative only. Fabricated
    // metadata cannot make its real ordinary default identify this new root.
    const executable = buildNativeOwners().owners['hepta-paper-rust'].path;
    assert.ok(path.isAbsolute(executable));
    const target = path.dirname(path.dirname(executable));
    const sha256 = `sha256:${(createHash('sha256').update(fs.readFileSync(executable)).digest('hex'))}`;
    const runtime = { owners: { 'hepta-paper-rust': { path: executable, sha256 } } };
    const context = { root, target, artifacts: { 'hepta-paper-rust': {
      manifestPath: path.join(root, 'rust/crates/hepta-paper-service/Cargo.toml'),
      sourcePath: path.join(root, 'rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs'), targetKind: ['bin'], profile: { test: false },
    } } };
    assert.throws(() => captureOwnRouteReplayGuardV1(root, environment, runtime, context), /compiled_workspace_context_differs/u);
    assert.notEqual(root, source);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual_guard_rejects_actual_resolved_package_lock_bytes_and_dependency_alias_or_namespace_changes', async () => {
  const { directory, root } = fixture(), environment = safeEnvironment();
  try {
    const files = ['docs/tools/node-rust-route-replay-guard.mjs', ...SOURCE_EVIDENCE_PRODUCER_PATHS, 'package.json', 'package-lock.json'];
    for (const file of files) {
      const destination = path.join(root, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(source, file), destination);
    }
    fs.writeFileSync(path.join(root, '.gitignore'), '/node_modules/\n', { flag: 'wx', mode: 0o600 });
    fs.mkdirSync(path.join(root, 'node_modules'));
    for (const name of ['espree', 'eslint-scope', 'acorn', 'acorn-jsx', 'eslint-visitor-keys', 'esrecurse', 'estraverse']) {
      fs.cpSync(actualParserPackageRoot(name), path.join(root, 'node_modules', name), { recursive: true, dereference: false });
    }
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Private Guard Fixture', '-c', 'user.email=guard@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', 'Actual module and locked package guard inputs');
    const own = await import(pathToFileURL(path.join(root, files[0])).href);
    const lock = path.join(root, 'package-lock.json'), lockBytes = fs.readFileSync(lock);
    let guard = own.captureOwnRouteReplayGuardV1(root, environment);
    assert.equal(guard.dependencies.closure.length, 7);
    assert.ok(guard.dependencies.closure.every(row => row.resolved.startsWith(path.join(root, 'node_modules', row.name) + path.sep)));
    fs.appendFileSync(lock, '\n');
    assert.throws(() => own.assertOwnRouteReplayGuardV1(guard, root, environment), refused); fs.writeFileSync(lock, lockBytes);
    guard = own.captureOwnRouteReplayGuardV1(root, environment);
    const resolved = guard.dependencies.closure.find(row => row.name === 'espree').resolved;
    const bytes = fs.readFileSync(resolved), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; fs.writeFileSync(resolved, changed);
    assert.throws(() => own.assertOwnRouteReplayGuardV1(guard, root, environment), refused); fs.writeFileSync(resolved, bytes);
    guard = own.captureOwnRouteReplayGuardV1(root, environment);
    const selected = path.join(root, 'node_modules', 'espree'), displaced = path.join(directory, 'displaced-espree');
    fs.renameSync(selected, displaced); fs.symlinkSync(displaced, selected);
    assert.throws(() => own.assertOwnRouteReplayGuardV1(guard, root, environment), refused); fs.unlinkSync(selected); fs.renameSync(displaced, selected);
    guard = own.captureOwnRouteReplayGuardV1(root, environment);
    fs.mkdirSync(path.join(root, 'node_modules', 'foreign-package'));
    assert.throws(() => own.assertOwnRouteReplayGuardV1(guard, root, environment), refused);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('actual_guard_rejects_same_mtime_native_elf_bytes_and_identical_byte_inode_replacement', () => {
  const environment = safeEnvironment(), runtime = buildNativeOwners();
  const executable = runtime.owners['hepta-paper-rust'].path, original = fs.readFileSync(executable);
  const target = path.dirname(path.dirname(executable));
  // This is the task's independently built private target, outside the source;
  // no other target or deployed executable is modified by the negative.
  assert.equal(target, process.env.CARGO_TARGET_DIR);
  const buildContext = { root: source, target, artifacts: { 'hepta-paper-rust': {
    manifestPath: path.join(source, 'rust/crates/hepta-paper-service/Cargo.toml'),
    sourcePath: path.join(source, 'rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs'), targetKind: ['bin'], profile: { test: false },
  } } };
  const owner = { owners: { 'hepta-paper-rust': runtime.owners['hepta-paper-rust'] } };
  const before = fs.statSync(executable); fs.utimesSync(executable, new Date(0), new Date(1000));
  try {
    let guard = captureOwnRouteReplayGuardV1(source, environment, owner, buildContext);
    const mtime = fs.statSync(executable, { bigint: true }).mtimeNs;
    const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
    fs.writeFileSync(executable, changed); fs.utimesSync(executable, new Date(0), new Date(1000));
    assert.equal(fs.statSync(executable, { bigint: true }).mtimeNs, mtime);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, source, environment, owner, buildContext), refused);
    fs.writeFileSync(executable, original);
    guard = captureOwnRouteReplayGuardV1(source, environment, owner, buildContext);
    const replacement = path.join(target, 'own-guard-elf-replacement');
    fs.writeFileSync(replacement, original, { flag: 'wx', mode: before.mode & 0o777 });
    fs.renameSync(replacement, executable);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, source, environment, owner, buildContext), refused);
  } finally { fs.writeFileSync(executable, original); fs.chmodSync(executable, before.mode & 0o777); fs.utimesSync(executable, before.atime, before.mtime); }
});
test('actual_guard_binds_the_external_default_store_missing_ancestor_and_leaf_and_refuses_creation_or_alias', () => {
  const { directory, root } = fixture(), environment = safeEnvironment();
  const runtime = path.join(directory, 'hepta-paper-runtime'), leaf = path.join(runtime, 'native-runtime/hepta-paper.sqlite');
  try {
    let guard = captureOwnRouteReplayGuardV1(root, environment);
    assert.equal(guard.defaultStoreAbsence.missingPath, runtime);
    assertOwnRouteReplayGuardV1(guard, root, environment);
    fs.mkdirSync(path.dirname(leaf), { recursive: true, mode: 0o700 });
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    guard = captureOwnRouteReplayGuardV1(root, environment);
    assert.equal(guard.defaultStoreAbsence.missingPath, leaf);
    assertOwnRouteReplayGuardV1(guard, root, environment);
    fs.writeFileSync(leaf, 'actual external default database appearance', { flag: 'wx', mode: 0o600 });
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    assert.throws(() => captureOwnRouteReplayGuardV1(root, environment), refused);
    fs.unlinkSync(leaf);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    const fresh = captureOwnRouteReplayGuardV1(root, environment);
    assertOwnRouteReplayGuardV1(fresh, root, environment);
    fs.symlinkSync('missing.sqlite', leaf);
    assert.throws(() => captureOwnRouteReplayGuardV1(root, environment), refused); fs.unlinkSync(leaf);
    fs.rmSync(runtime, { recursive: true }); fs.symlinkSync('missing-runtime', runtime);
    assert.throws(() => captureOwnRouteReplayGuardV1(root, environment), refused); fs.unlinkSync(runtime);
    guard = captureOwnRouteReplayGuardV1(root, environment);
    const replacement = path.join(directory, 'replacement-runtime'); fs.mkdirSync(replacement);
    fs.renameSync(replacement, runtime);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    fs.rmSync(runtime, { recursive: true });
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    assertOwnRouteReplayGuardV1(captureOwnRouteReplayGuardV1(root, environment), root, environment);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual_guard_binds_outside_cargo_and_optional_git_config_missing_edges_and_refuses_restoration', () => {
  const { directory, root } = fixture(), environment = safeEnvironment();
  const cargoHome = path.join(directory, 'cargo-home'); fs.mkdirSync(cargoHome, { mode: 0o700 });
  environment.CARGO_HOME = cargoHome;
  try {
    for (const file of [path.join(cargoHome, 'config.toml'), path.join(root, '.git/config.worktree')]) {
      const guard = captureOwnRouteReplayGuardV1(root, environment);
      assertOwnRouteReplayGuardV1(guard, root, environment);
      fs.writeFileSync(file, '# actual transient input\n', { flag: 'wx', mode: 0o600 });
      assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
      fs.unlinkSync(file);
      assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
      assertOwnRouteReplayGuardV1(captureOwnRouteReplayGuardV1(root, environment), root, environment);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('actual_guard_binds_tool_search_absence_permission_nondirectory_and_alias_before_fallback', () => {
  const { directory, root } = fixture(), original = process.env.PATH;
  const prefix = path.join(directory, 'tool-prefix'); fs.mkdirSync(prefix, { mode: 0o700 });
  const leaf = path.join(prefix, 'git');
  try {
    process.env.PATH = `${prefix}${path.delimiter}${original}`;
    let environment = safeEnvironment(), guard = captureOwnRouteReplayGuardV1(root, environment);
    fs.copyFileSync('/usr/bin/git', leaf); fs.chmodSync(leaf, 0o550);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused); fs.unlinkSync(leaf);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    assertOwnRouteReplayGuardV1(captureOwnRouteReplayGuardV1(root, environment), root, environment);
    fs.writeFileSync(leaf, 'non-executable ignored tool candidate', { flag: 'wx', mode: 0o600 });
    guard = captureOwnRouteReplayGuardV1(root, environment);
    assert.equal(guard.tools.find(row => row.name === 'git').search[0].accessError, 'EACCES');
    assertOwnRouteReplayGuardV1(guard, root, environment);
    fs.chmodSync(leaf, 0o400); fs.chmodSync(leaf, 0o600);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused); fs.unlinkSync(leaf);
    const blocking = path.join(directory, 'blocking-prefix'); fs.writeFileSync(blocking, 'actual ENOTDIR prefix');
    process.env.PATH = `${blocking}${path.delimiter}${original}`; environment = safeEnvironment();
    guard = captureOwnRouteReplayGuardV1(root, environment);
    assert.equal(guard.tools.find(row => row.name === 'git').search[0].accessError, 'ENOTDIR');
    assertOwnRouteReplayGuardV1(guard, root, environment);
    fs.writeFileSync(blocking, 'changed ENOTDIR prefix');
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    const alias = path.join(directory, 'alias-prefix'); fs.symlinkSync(prefix, alias);
    process.env.PATH = `${alias}${path.delimiter}${original}`; environment = safeEnvironment();
    guard = captureOwnRouteReplayGuardV1(root, environment);
    assert.equal(guard.tools.find(row => row.name === 'git').search[0].links.length, 1);
    assertOwnRouteReplayGuardV1(guard, root, environment);
    fs.copyFileSync('/usr/bin/git', leaf); fs.chmodSync(leaf, 0o550); fs.unlinkSync(leaf);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    assertOwnRouteReplayGuardV1(captureOwnRouteReplayGuardV1(root, environment), root, environment);
    fs.symlinkSync('missing-tool-target', leaf);
    guard = captureOwnRouteReplayGuardV1(root, environment);
    assert.equal(guard.tools.find(row => row.name === 'git').search[0].links.length, 2);
    assertOwnRouteReplayGuardV1(guard, root, environment);
    fs.unlinkSync(leaf); fs.symlinkSync('other-missing-tool-target', leaf);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
  } finally { process.env.PATH = original; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual_guard_binds_selected_tool_ancestor_alias_epoch_and_refuses_identical_target_restoration', () => {
  const { directory, root } = fixture(), original = process.env.PATH;
  const outside = fs.mkdtempSync(path.join(os.userInfo().homedir, '.hepta-selected-tool-'));
  const real = path.join(outside, 'real-bin'), alias = path.join(outside, 'alias-bin');
  try {
    fs.mkdirSync(real, { mode: 0o700 });
    for (const name of ['cargo', 'rustc', 'git', 'python3']) {
      const selected = original.split(path.delimiter).map(row => path.join(row, name)).find(row => {
        try { fs.accessSync(row, fs.constants.X_OK); return true; }
        catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; return false; }
      });
      assert.ok(selected); fs.symlinkSync(fs.realpathSync(selected), path.join(real, name));
    }
    fs.symlinkSync(real, alias); process.env.PATH = `${alias}${path.delimiter}${original}`;
    const environment = safeEnvironment(), guard = captureOwnRouteReplayGuardV1(root, environment);
    assertOwnRouteReplayGuardV1(guard, root, environment);
    fs.unlinkSync(alias); fs.symlinkSync(real, alias);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    assertOwnRouteReplayGuardV1(captureOwnRouteReplayGuardV1(root, environment), root, environment);
  } finally { process.env.PATH = original; fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('actual_guard_admits_the_exact_locked_parent_and_refuses_lock_alias_and_shadow_root_changes', async () => {
  const { directory, root } = fixture(), environment = safeEnvironment();
  try {
    const files = ['docs/tools/node-rust-route-replay-guard.mjs', ...SOURCE_EVIDENCE_PRODUCER_PATHS, 'package.json', 'package-lock.json'];
    for (const file of files) {
      const destination = path.join(root, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(source, file), destination);
    }
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, file), path.join(directory, file));
    const dependencies = path.join(directory, 'node_modules'); fs.mkdirSync(dependencies);
    for (const name of ['espree', 'eslint-scope', 'acorn', 'acorn-jsx', 'eslint-visitor-keys', 'esrecurse', 'estraverse']) {
      fs.cpSync(actualParserPackageRoot(name), path.join(dependencies, name), { recursive: true, dereference: false });
    }
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Private Guard Fixture', '-c', 'user.email=guard@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', 'Actual lock-bound parent dependency fixture');
    const own = await import(pathToFileURL(path.join(root, files[0])).href);
    let guard = own.captureOwnRouteReplayGuardV1(root, environment);
    assert.equal(guard.dependencies.requestedRoot, dependencies);
    assert.equal(guard.dependencies.actualRoot, dependencies);
    assert.equal(guard.dependencies.candidateRootAbsence.path, path.join(root, 'node_modules'));
    assert.equal(guard.dependencies.closure.length, 7);
    own.assertOwnRouteReplayGuardV1(guard, root, environment);
    const shadow = path.join(root, 'node_modules'); fs.mkdirSync(shadow);
    assert.throws(() => own.assertOwnRouteReplayGuardV1(guard, root, environment), refused); fs.rmdirSync(shadow);
    assert.throws(() => own.assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    guard = own.captureOwnRouteReplayGuardV1(root, environment);
    const lock = path.join(directory, 'package-lock.json'), lockBytes = fs.readFileSync(lock);
    fs.appendFileSync(lock, '\n');
    assert.throws(() => own.captureOwnRouteReplayGuardV1(root, environment), refused); fs.writeFileSync(lock, lockBytes);
    assert.throws(() => own.assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    guard = own.captureOwnRouteReplayGuardV1(root, environment);
    own.assertOwnRouteReplayGuardV1(guard, root, environment);
    const displaced = path.join(directory, 'displaced-dependencies');
    fs.renameSync(dependencies, displaced); fs.symlinkSync(displaced, dependencies);
    assert.throws(() => own.captureOwnRouteReplayGuardV1(root, environment), refused);
    fs.unlinkSync(dependencies); fs.renameSync(displaced, dependencies);
    assert.throws(() => own.assertOwnRouteReplayGuardV1(guard, root, environment), refused);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual_guard_binds_git_ignore_rules_clean_status_and_refuses_identical_rule_restoration', () => {
  const { directory, root } = fixture(), environment = safeEnvironment();
  try {
    const exclude = path.join(root, '.git/info/exclude'), original = fs.readFileSync(exclude);
    const rules = Buffer.concat([original, Buffer.from('\nignored-existing-input\n')]);
    fs.writeFileSync(exclude, rules);
    fs.writeFileSync(path.join(root, 'ignored-existing-input'), 'already observed ignored source bytes');
    assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    const guard = captureOwnRouteReplayGuardV1(root, environment);
    assertOwnRouteReplayGuardV1(guard, root, environment);
    // Only Git metadata changes; the observed source tree, HEAD and index stay
    // exact. The previously ignored file now makes the real subject dirty.
    fs.writeFileSync(exclude, original);
    assert.match(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), /ignored-existing-input/u);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    fs.writeFileSync(exclude, rules);
    assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual_guard_checks_head_and_missing_unreachable_historical_graph_in_the_same_strict_invocation', () => {
  const { directory, root } = fixture(), environment = safeEnvironment();
  try {
    const blob = git(root, 'hash-object', '-w', 'source.txt');
    const created = spawnSync('git', ['-C', root, 'mktree'], {
      input: ['100644 blob ' + blob + '\tother-history.txt', ''].join('\n'),
      encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 1024 * 1024,
    });
    assert.equal(created.status, 0, created.stderr || created.error?.message);
    const historical = created.stdout.trim(); assert.match(historical, /^[0-9a-f]{40}$/u);
    const guard = captureOwnRouteReplayGuardV1(root, environment, undefined, undefined, [historical]);
    assertOwnRouteReplayGuardV1(guard, root, environment, undefined, undefined, [historical]);
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment), refused);
    // HEAD itself remains complete, but this separately required historical
    // root has genuinely disappeared. Neither a valid HEAD nor its old verdict
    // can stand in for verification of the current additional graph.
    fs.unlinkSync(path.join(root, '.git/objects', historical.slice(0, 2), historical.slice(2)));
    git(root, 'fsck', '--strict', '--no-reflogs', '--no-dangling', 'HEAD');
    assert.throws(() => assertOwnRouteReplayGuardV1(guard, root, environment,
      undefined, undefined, [historical]), refused);
    assert.throws(() => captureOwnRouteReplayGuardV1(root, environment,
      undefined, undefined, ['not-an-object-id']), refused);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
