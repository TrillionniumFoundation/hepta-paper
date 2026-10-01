// Git object and source-input observation for the existing evidence verifier.
// This module owns no receipt, promotion, test selection or runtime authority.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function fail(code, detail = '') {
  const suffix = detail ? `: ${detail}` : '';
  throw new Error(`${code}${suffix}`);
}


export function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: options.timeout,
  });
  if (result.error) fail('process_spawn_failed', `${program}: ${result.error.message}`);
  return result;
}

export function git(root, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' });
  const result = run('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-C', root, ...args],
    { input, env, timeout: 60_000 });
  if (result.status !== 0) fail('git_command_failed', `${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// One committed input observation for evidence producers and local CLI replay.
// This binds actual files and executable modes to HEAD, not a clean-status hint.
// A normally dirty checkout remains a diagnostic subject with no acceptance.
export function captureCommittedSourceSubject(root) {
  const realRoot = fs.realpathSync(root);
  if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== realRoot) {
    fail('source_git_worktree_root_mismatch');
  }
  const [commit, tree] = git(root, ['rev-parse', 'HEAD', 'HEAD^{tree}']).split('\n');
  if (![commit, tree].every(value => /^[0-9a-f]{40}$/u.test(value))) fail('source_git_subject_invalid');
  const subject = { commit, tree, committedClean: git(root, ['status', '--porcelain=v1', '--untracked-files=all']) === '' };
  if (!subject.committedClean) return subject;
  const configNames = git(root, ['config', '--no-includes', '--name-only', '--list']);
  if (configNames.split('\n').some(value => {
    const key = value.toLowerCase();
    return key === 'extensions.partialclone' || key.endsWith('.promisor')
      || key.startsWith('fsck.') || key.startsWith('include.') || key.startsWith('includeif.');
  })) fail('source_git_integrity_bypass_configuration');
  const parse = (output, tree, error) => {
    if (!output.endsWith('\0')) fail(error);
    const rows = output.slice(0, -1).split('\0');
    if (rows.length > 16_384) fail('source_file_count_limit');
    const result = new Map();
    for (const row of rows) {
      const match = (tree ? /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/u
        : /^(\d{6}) ([0-9a-f]{40}) 0\t([\s\S]+)$/u).exec(row);
      if (!match || !['100644', '100755', '160000'].includes(match[1])) fail(error);
      const relative = match[tree ? 4 : 3];
      if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')
          || result.has(relative) || (tree && match[2] !== (match[1] === '160000' ? 'commit' : 'blob'))) fail(error);
      result.set(relative, { mode: match[1], blob: match[tree ? 3 : 2] });
    }
    return result;
  };
  // git() strips surrounding whitespace only; NUL preserves every path byte.
  const selected = parse(git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]), true, 'source_selected_tree_invalid');
  const indexed = parse(git(root, ['ls-files', '--stage', '-z']), false, 'source_index_invalid');
  if (selected.size !== indexed.size) fail('source_index_tree_mismatch');
  for (const [relative, expected] of selected) {
    if (JSON.stringify(indexed.get(relative)) !== JSON.stringify(expected)) fail('source_index_tree_mismatch', relative);
  }
  const flags = git(root, ['ls-files', '-v', '-z']);
  if (!flags.endsWith('\0') || flags.slice(0, -1).split('\0').some(row => !row.startsWith('H '))) {
    fail('source_index_hidden_input_flag');
  }
  git(root, ['fsck', '--strict', '--no-reflogs', '--no-dangling', commit]);
  const references = [];
  try {
    for (const [relative, expected] of selected) {
      if (expected.mode === '160000') {
        const reference = observeGitlinkReference(realRoot, relative, expected.blob);
        references.push(reference);
        if (reference.value.state !== 'empty_directory') fail('source_gitlink_missing', relative);
      }
      else readPinnedSource(root, relative, expected);
    }
    for (const reference of references) reference.assertCurrent();
    if (git(root, ['rev-parse', 'HEAD', 'HEAD^{tree}']) !== `${commit}\n${tree}`
      || git(root, ['status', '--porcelain=v1', '--untracked-files=all']) !== '') {
      fail('source_subject_changed', 'after_complete_input_observation');
    }
    for (const reference of references) reference.assertCurrent();
    if (references.length) subject.gitlinkReferenceProfile = {
      version: 1, kind: 'UnmaterializedGitlinkReferences',
      observationScope: 'selected_tree_and_index_commits_without_nested_source_bytes',
      references: references.map(reference => reference.value),
    };
  } finally {
    for (const reference of references) reference.close();
  }
  return subject;
}

// This profile binds immutable Git references only. Materialized submodules
// require their separate content/closure owner; Git must never search from an
// empty gitlink directory and silently discover the parent repository.
function observeGitlinkReference(root, relative, commit) {
  const absolute = path.join(root, relative), parents = [];
  const identity = ['dev', 'ino', 'mode', 'uid', 'gid'];
  const complete = [...identity, 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
  const same = (a, b, fields) => fields.every(key => a[key] === b[key]);
  const pin = (named, descriptor, fields) => {
    try {
      const metadata = fs.fstatSync(descriptor, { bigint: true });
      const current = fs.lstatSync(named, { bigint: true });
      if (!metadata.isDirectory() || !current.isDirectory() || !same(metadata, current, fields)) {
        fail('source_gitlink_path_invalid', relative);
      }
      return { named, descriptor, metadata, fields };
    } catch (cause) {
      fs.closeSync(descriptor);
      throw cause;
    }
  };
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let leaf;
  const close = () => {
    if (leaf) fs.closeSync(leaf.descriptor);
    for (const parent of parents.reverse()) fs.closeSync(parent.descriptor);
  };
  try {
    let named = path.parse(absolute).root;
    parents.push(pin(named, fs.openSync(named, flags), identity));
    for (const component of path.dirname(absolute).slice(named.length).split(path.sep).filter(Boolean)) {
      const descriptor = fs.openSync(`/proc/self/fd/${parents.at(-1).descriptor}/${component}`, flags);
      named = path.join(named, component);
      parents.push(pin(named, descriptor, identity));
      if (parents.length > 4096) fail('source_gitlink_ancestor_count_limit', relative);
    }
    try {
      const descriptor = fs.openSync(`/proc/self/fd/${parents.at(-1).descriptor}/${path.basename(absolute)}`, flags);
      leaf = pin(absolute, descriptor, complete);
    } catch (cause) {
      if (cause.code !== 'ENOENT') fail('source_gitlink_path_invalid', relative);
    }
    const assertCurrent = () => {
      for (const entry of [...parents, ...(leaf ? [leaf] : [])]) {
        const namedMetadata = fs.lstatSync(entry.named, { bigint: true });
        if (!namedMetadata.isDirectory()
            || !same(entry.metadata, namedMetadata, entry.fields)
            || !same(entry.metadata, fs.fstatSync(entry.descriptor, { bigint: true }), entry.fields)) {
          fail('source_gitlink_changed', relative);
        }
      }
      if (!leaf) {
        try { fs.lstatSync(`/proc/self/fd/${parents.at(-1).descriptor}/${path.basename(absolute)}`); }
        catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
        fail('source_gitlink_changed', relative);
      }
      const directory = fs.opendirSync(`/proc/self/fd/${leaf.descriptor}`);
      try { if (directory.readSync() !== null) fail('source_gitlink_materialized', relative); }
      finally { directory.closeSync(); }
      const namedMetadata = fs.lstatSync(absolute, { bigint: true });
      if (!same(leaf.metadata, namedMetadata, complete)
          || !same(leaf.metadata, fs.fstatSync(leaf.descriptor, { bigint: true }), complete)) {
        fail('source_gitlink_changed', relative);
      }
    };
    assertCurrent();
    const project = entry => ({ path: entry.named,
      ...Object.fromEntries(entry.fields.map(key => [key, String(entry.metadata[key])])) });
    return { assertCurrent, close, value: { path: relative, mode: '160000', commit,
      state: leaf ? 'empty_directory' : 'absent', parents: parents.map(project), leaf: leaf ? project(leaf) : null } };
  } catch (cause) {
    close();
    throw cause;
  }
}


export function trackedBlob(root, relative) {
  const output = git(root, ['ls-files', '-s', '--', relative]);
  const match = /^(\d{6}) ([0-9a-f]{40}) 0\t(.+)$/u.exec(output);
  if (!match || match[3] !== relative) fail('tracked_blob_required', relative);
  return { mode: match[1], blob: match[2] };
}

// Compare the actual bounded bytes with the Git object, not merely the index.
// Git's assume-unchanged/skip-worktree hints are not source-evidence authority.
export function readPinnedSource(root, relative, expected) {
  const absolute = path.resolve(root, relative);
  const rootReal = fs.realpathSync(root);
  const parentReal = fs.realpathSync(path.dirname(absolute));
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
    fail('path_escape', relative);
  }
  const namedBefore = fs.lstatSync(absolute);
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) fail('regular_file_required', relative);
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY
    | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > 16n * 1024n * 1024n) {
      fail('regular_bounded_source_required', relative);
    }
    const chunks = [];
    let count = 0;
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const length = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (length === 0) break;
      count += length;
      if (count > 16 * 1024 * 1024) fail('source_byte_limit', relative);
      chunks.push(chunk.subarray(0, length));
    }
    const bytes = Buffer.concat(chunks);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(absolute, { bigint: true });
    const identity = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    if (identity.some((key) => before[key] !== after[key] || after[key] !== named[key])
        || BigInt(bytes.length) !== before.size) {
      fail('source_subject_changed', relative);
    }
    const actualMode = (before.mode & 0o111n) === 0n ? '100644' : '100755';
    // Git is the canonical object-format owner; no independent weak-hash
    // implementation or text/clean-filter normalization is introduced here.
    const actualBlob = git(root, ['hash-object', '--no-filters', '--stdin'], bytes);
    const indexed = trackedBlob(root, relative);
    if (indexed.mode !== expected.mode || indexed.blob !== expected.blob) {
      fail('git_blob_mismatch', relative);
    }
    if (actualMode !== expected.mode || actualBlob !== expected.blob) {
      fail('source_worktree_blob_mismatch', relative);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

// Start/end observation of the same source subject, not continuous isolation
// from malicious same-UID writers or authentication of the test producer.
export function assertSourceSubject(root, subject, inputs) {
  const expected = `${subject.head}\n${subject.tree}`;
  if (git(root, ['rev-parse', 'HEAD', 'HEAD^{tree}']) !== expected
      || git(root, ['status', '--porcelain=v1', '--untracked-files=no']) !== '') {
    fail('source_subject_changed', 'head_tree_or_index');
  }
  for (const [relative, pin] of inputs) readPinnedSource(root, relative, pin);
  if (git(root, ['rev-parse', 'HEAD', 'HEAD^{tree}']) !== expected
      || git(root, ['status', '--porcelain=v1', '--untracked-files=no']) !== '') {
    fail('source_subject_changed', 'after_source_observation');
  }
}
