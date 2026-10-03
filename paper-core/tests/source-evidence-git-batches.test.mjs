import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { captureCommittedSourceSubject, git, readPinnedSource } from '../src/source-evidence-git-inputs.mjs';

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
