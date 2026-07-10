import fs from 'node:fs';
import path from 'node:path';

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeDirRecursive(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function acquireLocalFileLock({
  lockDir,
  pid = process.pid,
  startedAt = new Date().toISOString(),
  owner = {},
  acquiredStatus = 'acquired_local_file_lock',
  blockedStatus = 'blocked_local_file_lock',
  busyBlockerCode = 'local_file_lock_already_running',
  busyNotes = null,
} = {}) {
  if (!lockDir) throw new Error('acquireLocalFileLock requires lockDir');
  const ownerFile = path.join(lockDir, 'owner.json');
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  try {
    fs.mkdirSync(lockDir);
    const lockOwner = {
      pid,
      startedAt,
      command: [process.execPath, ...process.argv.slice(1)],
      cwd: process.cwd(),
      ...owner,
    };
    fs.writeFileSync(ownerFile, `${JSON.stringify(lockOwner, null, 2)}\n`, 'utf8');
    return {
      ok: true,
      status: acquiredStatus,
      lockDir,
      owner: lockOwner,
      staleRemoved: false,
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const existingOwner = readJsonFile(ownerFile) || {};
  if (!processAlive(existingOwner.pid)) {
    const staleRemoved = removeDirRecursive(lockDir);
    if (staleRemoved) {
      return acquireLocalFileLock({
        lockDir,
        pid,
        startedAt,
        owner,
        acquiredStatus,
        blockedStatus,
        busyBlockerCode,
        busyNotes,
      });
    }
  }

  return {
    ok: false,
    status: blockedStatus,
    lockDir,
    owner: existingOwner,
    staleRemoved: false,
    blockers: [{
      code: busyBlockerCode,
      notes: busyNotes
        ? busyNotes(existingOwner)
        : (existingOwner.pid
          ? `local file lock is held by pid ${existingOwner.pid}`
          : 'local file lock exists without a live owner record'),
    }],
  };
}

export function releaseLocalFileLock(lock = {}) {
  if (!lock?.ok || !lock.lockDir) return false;
  const owner = readJsonFile(path.join(lock.lockDir, 'owner.json')) || {};
  if (Number(owner.pid) !== Number(lock.owner?.pid)) return false;
  return removeDirRecursive(lock.lockDir);
}
