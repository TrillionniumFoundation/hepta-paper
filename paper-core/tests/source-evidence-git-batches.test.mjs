import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { captureCommittedSourceSubject, fail, git, readPinnedSource } from '../src/source-evidence-git-inputs.mjs';
import { assertPublicRSourceReferenceCurrent } from '../src/source-evidence-public-r-inputs.mjs';

const moduleFile = fileURLToPath(new URL('../src/source-evidence-git-inputs.mjs', import.meta.url));
const originalEnvironment = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'TMPDIR',
  'CARGO_HOME', 'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS', 'RUSTFLAGS', 'RUSTUP_HOME', 'CARGO_TERM_COLOR', 'TZ']
  .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
const fdCount = () => fs.readdirSync('/proc/self/fd').length;
function command(root, args) {
  const output = spawnSync('/usr/bin/git', ['-C', root, ...args], { env: originalEnvironment,
    encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(output.status, 0, output.stderr || output.error?.message); return output.stdout.trim();
}
function fixture(count = 260) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-git-held-batches-'));
  const root = path.join(directory, 'source'), tools = path.join(directory, 'tools');
  fs.mkdirSync(root); fs.mkdirSync(tools);
  for (let index = 0; index < count; index++) {
    const named = path.join(root, `source-${String(index).padStart(3, '0')}`);
    const bytes = index % 4 === 0 ? Buffer.alloc(0) : index % 4 === 1 ? Buffer.from([0, 1, 255, 10])
      : index % 4 === 2 ? Buffer.from('Unicode 汉字 😀\r\n') : Buffer.from(`value-${index}\n`);
    fs.writeFileSync(named, bytes, { flag: 'wx', mode: index % 5 === 0 ? 0o755 : 0o644 });
  }
  command(root, ['init', '--quiet']); command(root, ['add', '.']);
  command(root, ['-c', 'user.name=Private Batch Fixture', '-c', 'user.email=batch@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', 'Actual bounded source corpus']);
  return { directory, root, tools };
}
function installObserver(fixture, operation) {
  const { directory, tools } = fixture;
  const wrapper = path.join(tools, 'git'), log = path.join(directory, 'git-operations.jsonl');
  fs.writeFileSync(wrapper, `#!/usr/bin/python3
import json,os,sys,pathlib,subprocess
args=sys.argv[1:]
if 'hash-object' in args and '--stdin-paths' in args:
    incoming=sys.stdin.buffer.read()
    with open(${JSON.stringify(log)},'a') as out: out.write(json.dumps({'paths':incoming.decode().splitlines()})+'\\n')
    operation=${JSON.stringify(operation)}
    count=len(pathlib.Path(${JSON.stringify(log)}).read_text().splitlines())
    if operation=='late_same_bytes': operation='same_bytes' if count==2 else 'observe'
    selected=pathlib.Path(${JSON.stringify(path.join(fixture.root, 'source-001'))})
    if operation=='replace':
        selected.rename(selected.with_name('displaced'))
        selected.write_bytes(b'changed named input')
    elif operation=='same_bytes':
        before=selected.stat(); raw=selected.read_bytes(); selected.write_bytes(raw);os.utime(selected,ns=(before.st_atime_ns,before.st_mtime_ns))
    elif operation=='ancestor':
        (selected.parent/'sibling-change').write_bytes(b'namespace mutation')
    elif operation=='failure': sys.exit(73)
    elif operation=='missing_output': sys.exit(0)
    elif operation=='extra_output':
        result=subprocess.run(['/usr/bin/git']+args,input=incoming,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=tuple(range(3,3+len(incoming.decode().splitlines()))))
        sys.stdout.buffer.write(result.stdout+b'0'*40+b'\\n');sys.stderr.buffer.write(result.stderr);sys.exit(result.returncode)
    result=subprocess.run(['/usr/bin/git']+args,input=incoming,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=tuple(range(3,3+len(incoming.decode().splitlines()))))
    sys.stdout.buffer.write(result.stdout);sys.stderr.buffer.write(result.stderr);sys.exit(result.returncode)
os.execv('/usr/bin/git',['/usr/bin/git']+args)
`, { flag: 'wx', mode: 0o755 });
  process.env.PATH = `${tools}${path.delimiter}${originalEnvironment.PATH}`;
  return log;
}
function restored() { process.env.PATH = originalEnvironment.PATH; }

function publicRFixture() {
  const input = fixture(4), original = fileURLToPath(new URL('../../', import.meta.url));
  const relative = 'docs/rust/qualification/r-source-route.v1.json';
  const route = JSON.parse(fs.readFileSync(path.join(original, relative)));
  fs.mkdirSync(path.dirname(path.join(input.root, relative)), { recursive: true });
  fs.copyFileSync(path.join(original, relative), path.join(input.root, relative));
  // Only the disposable fixture writes Git objects. Historical authority
  // objects are read through an alternate, without touching the real index.
  const objectDirectory = command(original, ['rev-parse', '--git-path', 'objects']);
  fs.mkdirSync(path.join(input.root, '.git/objects/info'), { recursive: true });
  fs.writeFileSync(path.join(input.root, '.git/objects/info/alternates'),
    path.resolve(original, objectDirectory) + '\n', { flag: 'wx' });
  command(input.root, ['add', relative]);
  command(input.root, ['update-index', '--add', '--cacheinfo',
    `160000,${route.originalGitlink.commit},${route.targetPath}`]);
  command(input.root, ['-c', 'user.name=Private Batch Fixture', '-c', 'user.email=batch@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', 'Exact public R content fixture']);
  const rows = command(original, ['ls-tree', '-r', '-z', route.publicHistoricalRoute.subtree]).slice(0, -1).split('\0');
  for (const row of rows) {
    const [, blob, name] = /^100644 blob ([0-9a-f]{40})\t(.+)$/u.exec(row);
    const file = path.join(input.root, route.targetPath, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    const raw = spawnSync('/usr/bin/git', ['-C', original, 'cat-file', 'blob', blob],
      { env: originalEnvironment, shell: false, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(raw.status, 0, raw.stderr.toString());
    fs.writeFileSync(file, raw.stdout, { flag: 'wx', mode: 0o644 });
  }
  return { ...input, route };
}

test('canonical_git_batches_observe_actual_public_107_blob_content_without_qualifying_gitlink_or_runtime', () => {
  const input = publicRFixture();
  try {
    const before = fdCount(), subject = captureCommittedSourceSubject(input.root);
    assert.equal(subject.committedClean, true);
    const profile = subject.publicRSourceContentProfile;
    assert.equal(profile.sourceTree, input.route.publicHistoricalRoute.subtree);
    assert.equal(profile.manifestBlob, input.route.publicHistoricalRoute.manifestBlob);
    assert.equal(profile.fileCount, 107);
    assert.equal(profile.physicalInputs.filter(row => row.blob).length, 107);
    assert.equal(profile.gitlinkCommitQualified, false);
    assert.equal(profile.productionAuthorized, false);
    assert.equal(profile.packageExecutionAllowed, false);
    assert.equal(profile.physicalAfterMatched, true);
    assert.equal(fdCount(), before);
  } finally { restored(); fs.rmSync(input.directory, { recursive: true, force: true }); }
});

function assertPublicRRefusal(operation) {
  const input = publicRFixture(), leaf = path.join(input.root, input.route.targetPath);
  const manifest = path.join(leaf, 'manifest.json'), raw = fs.readFileSync(manifest);
  const before = fdCount();
  try {
    const extra = path.join(leaf, operation === 'extra' ? '.git' : 'unexpected-link');
    if (operation === 'extra') fs.mkdirSync(extra);
    else if (operation === 'missing') fs.unlinkSync(manifest);
    else if (operation === 'mode') fs.chmodSync(manifest, 0o755);
    else if (operation === 'symlink') { fs.unlinkSync(manifest); fs.symlinkSync(path.join(input.directory, 'external'), manifest); }
    else if (operation === 'hardlink') fs.linkSync(manifest, extra);
    else { const changed = Buffer.from(raw); changed[0] ^= 1; fs.writeFileSync(manifest, changed); }
    const refusal = operation === 'extra' ? /git_command_failed: status.*not recognized as a git repository/u
      : /public_r_|source_worktree_blob_mismatch/u;
    assert.throws(() => captureCommittedSourceSubject(input.root), refusal, operation);
    assert.equal(fdCount(), before, operation);
  } finally { restored(); fs.rmSync(input.directory, { recursive: true, force: true }); }
}

test('canonical_git_batches_refuse_public_R_extra', () => assertPublicRRefusal('extra'));
test('canonical_git_batches_refuse_public_R_missing', () => assertPublicRRefusal('missing'));
test('canonical_git_batches_refuse_public_R_mode', () => assertPublicRRefusal('mode'));
test('canonical_git_batches_refuse_public_R_symlink', () => assertPublicRRefusal('symlink'));
test('canonical_git_batches_refuse_public_R_hardlink', () => assertPublicRRefusal('hardlink'));
test('canonical_git_batches_refuse_public_R_bytes', () => assertPublicRRefusal('bytes'));

test('canonical_git_batches_recompute_all_actual_bytes_and_modes_in_fixed_128_fd_groups', () => {
  const input = fixture();
  try {
    const expected = { commit: command(input.root, ['rev-parse', 'HEAD']),
      tree: command(input.root, ['rev-parse', 'HEAD^{tree}']), committedClean: true };
    // The previous exact individual source owner remains an independent oracle.
    const selected = command(input.root, ['ls-files', '--stage', '-z']).slice(0, -1).split('\0');
    for (const row of selected) {
      const [, mode, blob, relative] = /^(\d{6}) ([0-9a-f]{40}) 0\t(.+)$/u.exec(row);
      assert.deepEqual(readPinnedSource(input.root, relative, { mode, blob }), fs.readFileSync(path.join(input.root, relative)));
    }
    const log = installObserver(input, 'observe'), before = fdCount();
    assert.deepEqual(captureCommittedSourceSubject(input.root), expected);
    assert.deepEqual(captureCommittedSourceSubject(input.root), expected);
    assert.equal(fdCount(), before);
    const batches = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(batches.map(row => row.paths.length), [128, 128, 4, 128, 128, 4]);
    for (const batch of batches) assert.deepEqual(batch.paths, batch.paths.map((_, index) => `/proc/self/fd/${index + 3}`));
    assert.equal(git(input.root, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  } finally { restored(); fs.rmSync(input.directory, { recursive: true, force: true }); }
});

test('canonical_git_batches_reject_held_named_raw_identity_and_namespace_changes_and_close_every_fd', () => {
  for (const operation of ['replace', 'same_bytes', 'ancestor']) {
    const input = fixture(4);
    try {
      installObserver(input, operation); const before = fdCount();
      assert.throws(() => captureCommittedSourceSubject(input.root), /source_subject_changed/u);
      assert.equal(fdCount(), before, operation);
    } finally { restored(); fs.rmSync(input.directory, { recursive: true, force: true }); }
  }
});

test('canonical_git_batches_recheck_the_first_batch_after_later_batch_mutation', () => {
  const input = fixture(260);
  try {
    installObserver(input, 'late_same_bytes'); const before = fdCount();
    assert.throws(() => captureCommittedSourceSubject(input.root), /source_subject_changed/u);
    assert.equal(fdCount(), before);
  } finally { restored(); fs.rmSync(input.directory, { recursive: true, force: true }); }
});

test('canonical_git_batches_reject_child_failure_missing_or_extra_output_and_close_every_fd', () => {
  for (const operation of ['failure', 'missing_output', 'extra_output']) {
    const input = fixture(4);
    try {
      installObserver(input, operation); const before = fdCount();
      assert.throws(() => captureCommittedSourceSubject(input.root), /git_command_failed|source_batch_git_output_invalid/u);
      assert.equal(fdCount(), before, operation);
    } finally { restored(); fs.rmSync(input.directory, { recursive: true, force: true }); }
  }
});

test('canonical_git_batches_preserve_hidden_index_flags_and_empty_gitlink_reference_guards', () => {
  const input = fixture(4);
  try {
    const commit = command(input.root, ['rev-parse', 'HEAD']);
    for (const name of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(input.root, name));
      command(input.root, ['update-index', '--add', '--cacheinfo', `160000,${commit},${name}`]);
    }
    command(input.root, ['-c', 'user.name=Private Batch Fixture', '-c', 'user.email=batch@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', 'Two exact empty gitlinks']);
    const result = captureCommittedSourceSubject(input.root);
    assert.deepEqual(result.gitlinkReferenceProfile.references.map(row => [row.path, row.state, row.commit]),
      [['alpha', 'empty_directory', commit], ['beta', 'empty_directory', commit]]);
    command(input.root, ['update-index', '--assume-unchanged', 'source-001']);
    assert.throws(() => captureCommittedSourceSubject(input.root), /source_index_hidden_input_flag/u);
    command(input.root, ['update-index', '--no-assume-unchanged', 'source-001']);
    fs.writeFileSync(path.join(input.root, 'alpha', 'materialized'), 'actual nested input');
    assert.throws(() => captureCommittedSourceSubject(input.root), /source_gitlink_materialized/u);
  } finally { restored(); fs.rmSync(input.directory, { recursive: true, force: true }); }
});

test('canonical_git_batches_close_partial_admission_after_actual_emfile_and_allow_fresh_retry', () => {
  const input = fixture(128);
  try {
    const script = `import fs from 'node:fs';import assert from 'node:assert/strict';
const {captureCommittedSourceSubject}=await import(${JSON.stringify(pathToFileURL(moduleFile).href)});
const before=fs.readdirSync('/proc/self/fd').length;
assert.throws(()=>captureCommittedSourceSubject(${JSON.stringify(input.root)}),error=>error.code==='EMFILE' && error.stack.includes('readPinnedSourceBatch'));
assert.equal(fs.readdirSync('/proc/self/fd').length,before);console.log('emfile_partial_fd_cleanup_verified');`;
    const output = spawnSync('python3', ['-c', 'import os,resource,sys;resource.setrlimit(resource.RLIMIT_NOFILE,(64,64));os.execv(sys.argv[1],sys.argv[1:])',
      process.execPath, '--input-type=module', '-e', script], { env: originalEnvironment,
      encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(output.status, 0, output.stderr || output.error?.message);
    assert.equal(output.stdout.trim(), 'emfile_partial_fd_cleanup_verified');
    assert.equal(captureCommittedSourceSubject(input.root).committedClean, true);
  } finally { restored(); fs.rmSync(input.directory, { recursive: true, force: true }); }
});

test('canonical_git_batches_owned_R_locator_rejects_deleted_unreachable_history_without_touching_alternate_objects', () => {
  const input = publicRFixture();
  try {
    const pathToTree = tree => {
      const output = spawnSync('/usr/bin/git', ['-C', input.root, 'mktree'], {
        input: `040000 tree ${tree}\tsource-cas\n`, env: originalEnvironment,
        encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 1024 * 1024,
      });
      assert.equal(output.status, 0, output.stderr || output.error?.message); return output.stdout.trim();
    };
    const scientific = pathToTree(input.route.publicHistoricalRoute.subtree);
    const nest = (tree, name) => {
      const output = spawnSync('/usr/bin/git', ['-C', input.root, 'mktree'], {
        input: `040000 tree ${tree}\t${name}\n`, env: originalEnvironment,
        encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 1024 * 1024,
      });
      assert.equal(output.status, 0, output.stderr || output.error?.message); return output.stdout.trim();
    };
    const outer = nest(nest(scientific, 'r-scientific'), 'runtime-images');
    const historical = command(input.root, ['-c', 'user.name=Private Locator Fixture',
      '-c', 'user.email=locator@example.invalid', '-c', 'commit.gpgsign=false', 'commit-tree', outer,
      '-m', 'Exclusive unreachable original locator fixture']);
    const routePath = path.join(input.root, 'docs/rust/qualification/r-source-route.v1.json');
    input.route.publicHistoricalRoute.commit = historical;
    fs.writeFileSync(routePath, JSON.stringify(input.route));
    command(input.root, ['add', 'docs/rust/qualification/r-source-route.v1.json']);
    command(input.root, ['-c', 'user.name=Private Locator Fixture', '-c', 'user.email=locator@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', 'Bound exclusive historical locator']);
    const subject = captureCommittedSourceSubject(input.root), owner = { fail, git, readPinnedSource };
    assertPublicRSourceReferenceCurrent(input.root, subject.publicRSourceContentProfile, owner);
    const object = path.join(input.root, '.git/objects', historical.slice(0, 2), historical.slice(2));
    assert.ok(fs.lstatSync(object).isFile());
    // The sole removed object was just created in this disposable repository.
    // Its alternate and every original public R object remain read-only.
    fs.unlinkSync(object);
    assert.equal(git(input.root, ['status', '--porcelain=v1', '--untracked-files=all']), '');
    assert.throws(() => assertPublicRSourceReferenceCurrent(input.root, subject.publicRSourceContentProfile, owner), /git_command_failed/u);
  } finally { restored(); fs.rmSync(input.directory, { recursive: true, force: true }); }
});
