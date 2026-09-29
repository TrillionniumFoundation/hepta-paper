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
  const result = run('git', ['-C', root, ...args], { input });
  if (result.status !== 0) fail('git_command_failed', `${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trim();
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

