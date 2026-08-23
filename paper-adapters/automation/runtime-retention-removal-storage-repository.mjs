import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';
import { writeDescriptorFullySync }
  from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import { retentionPathExists } from './runtime-retention-scope-repository.mjs';

const MOVE_BINARY = '/usr/bin/mv';
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function trustedMoveIdentity() {
  const stat = fs.lstatSync(MOVE_BINARY, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0n || stat.gid !== 0n
    || stat.nlink !== 1n || (Number(stat.mode) & 0o022) !== 0) {
    throw new Error('runtime_retention_removal_recovery_move_untrusted');
  }
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs].map(String).join(':');
}

export function writeFixedRetentionRemovalJsonSync(
  candidate,
  temporaryName,
  value,
  { mode = 0o400 } = {},
) {
  const parent = path.dirname(candidate);
  const temporary = path.join(parent, temporaryName);
  let descriptor = null;
  let created = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      mode,
    );
    created = true;
    writeDescriptorFullySync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, candidate);
    fsyncDirectorySync(parent);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (created) {
      try { fs.unlinkSync(temporary); } catch { /* Preserve the original error. */ }
    }
    throw error;
  }
}

export function moveRetentionRemovalNoReplaceSync(
  sourceDescriptor,
  sourceName,
  targetDescriptor,
  targetName,
) {
  const before = trustedMoveIdentity();
  const moved = spawnSync(MOVE_BINARY, [
    '--no-copy', '--no-clobber', '--no-target-directory', '--',
    `/proc/self/fd/3/${sourceName}`, `/proc/self/fd/4/${targetName}`,
  ], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe', sourceDescriptor, targetDescriptor],
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  if (before !== trustedMoveIdentity() || moved.error || moved.signal
    || moved.status !== 0 || moved.stdout || moved.stderr) {
    throw new Error('runtime_retention_removal_recovery_move_failed');
  }
}

export function removeRetentionRemovalTreeDurablySync(candidate) {
  if (!retentionPathExists(candidate)) return;
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fs.unlinkSync(candidate);
    fsyncDirectorySync(path.dirname(candidate));
    return;
  }
  fs.chmodSync(candidate, 0o700);
  for (const name of fs.readdirSync(candidate).sort()) {
    removeRetentionRemovalTreeDurablySync(path.join(candidate, name));
  }
  fsyncDirectorySync(candidate);
  fs.rmdirSync(candidate);
  fsyncDirectorySync(path.dirname(candidate));
}
