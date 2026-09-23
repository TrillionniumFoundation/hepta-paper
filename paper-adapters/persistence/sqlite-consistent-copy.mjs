import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

const OWNER_ONLY_FILE_MODE = 0o600;

function currentUserId() {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function assertSafeDestinationParent(destinationPath) {
  const parent = path.dirname(destinationPath);
  let stat;
  try {
    stat = fs.lstatSync(parent);
  } catch {
    throw new Error('sqlite_copy_destination_parent_missing');
  }
  const owner = currentUserId();
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || fs.realpathSync(parent) !== parent
    || (owner !== null && stat.uid !== owner)
    || (stat.mode & 0o022) !== 0) {
    throw new Error('sqlite_copy_destination_parent_unsafe');
  }
  return Object.freeze({ parent, dev: stat.dev, ino: stat.ino });
}

function assertSource(sourcePath) {
  let stat;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch {
    throw new Error('sqlite_copy_source_missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(sourcePath) !== sourcePath) {
    throw new Error('sqlite_copy_source_unsafe');
  }
}

function matchesIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function assertDestinationIdentity(destinationPath, identity, { expectedLinks = 1 } = {}) {
  const stat = fs.lstatSync(destinationPath);
  const owner = currentUserId();
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || !matchesIdentity(stat, identity)
    || stat.nlink !== expectedLinks
    || (stat.mode & 0o777) !== OWNER_ONLY_FILE_MODE
    || (owner !== null && stat.uid !== owner)
    || fs.realpathSync(destinationPath) !== destinationPath) {
    throw new Error('sqlite_copy_destination_identity_invalid');
  }
  return stat;
}

function removeIdentityFile(destinationPath, identity) {
  try {
    const stat = fs.lstatSync(destinationPath);
    if (matchesIdentity(stat, identity)) fs.unlinkSync(destinationPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function assertStagingDirectory(stagingRoot, identity = null) {
  const stat = fs.lstatSync(stagingRoot);
  const owner = currentUserId();
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || (identity && !matchesIdentity(stat, identity))
    || (stat.mode & 0o777) !== 0o700
    || (owner !== null && stat.uid !== owner)
    || fs.realpathSync(stagingRoot) !== stagingRoot) {
    throw new Error('sqlite_copy_staging_directory_unsafe');
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function removeStagingDirectory(stagingRoot, identity) {
  try {
    const stat = fs.lstatSync(stagingRoot);
    if (matchesIdentity(stat, identity)) fs.rmdirSync(stagingRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function removeStagingSidecars(stagingPath) {
  const owner = currentUserId();
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const candidate = `${stagingPath}${suffix}`;
    let stat;
    try { stat = fs.lstatSync(candidate); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || (owner !== null && stat.uid !== owner)) {
      throw new Error('sqlite_copy_staging_sidecar_unsafe');
    }
    removeIdentityFile(candidate, Object.freeze({ dev: stat.dev, ino: stat.ino }));
  }
}

function assertStagingSidecarsAbsent(stagingPath) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      fs.lstatSync(`${stagingPath}${suffix}`);
      throw new Error('sqlite_copy_staging_sidecar_unexpected');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function fileSha256(candidate) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let offset = 0;
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function immutableSqliteLocation(candidate) {
  const location = pathToFileURL(candidate);
  location.searchParams.set('mode', 'ro');
  location.searchParams.set('immutable', '1');
  return location;
}

function verifySqliteCopy(candidate) {
  const location = immutableSqliteLocation(candidate);
  const database = new DatabaseSync(location, { readOnly: true });
  try {
    const quickCheck = String(database.prepare('PRAGMA quick_check;').get()?.quick_check || 'unknown');
    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check;').all();
    if (quickCheck !== 'ok' || foreignKeyViolations.length !== 0) {
      throw new Error('sqlite_copy_restore_verification_failed');
    }
  } finally {
    database.close();
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  );
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export async function copySqliteDatabase({
  sourcePath,
  destinationPath,
  sourceImmutable = false,
} = {}) {
  if (!sourcePath || !destinationPath) {
    throw new Error('existing SQLite source and destination paths are required');
  }
  if (typeof sourceImmutable !== 'boolean') {
    throw new Error('sqlite_copy_source_immutable_flag_invalid');
  }
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) throw new Error('sqlite_copy_source_destination_conflict');
  assertSource(source);
  const parentIdentity = assertSafeDestinationParent(destination);
  const stagingRoot = path.join(
    parentIdentity.parent,
    `.sqlite-copy-${path.basename(destination)}-${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  const stagingIdentity = assertStagingDirectory(stagingRoot);
  const stagingPath = path.join(stagingRoot, 'database.sqlite');
  let descriptor;
  let destinationIdentity;
  let database;
  let published = false;
  try {
    descriptor = fs.openSync(
      stagingPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      OWNER_ONLY_FILE_MODE,
    );
    const created = fs.fstatSync(descriptor);
    destinationIdentity = Object.freeze({ dev: created.dev, ino: created.ino });
    assertDestinationIdentity(stagingPath, destinationIdentity);
    fs.closeSync(descriptor);
    descriptor = undefined;

    database = new DatabaseSync(
      sourceImmutable ? immutableSqliteLocation(source) : source,
      { readOnly: true },
    );
    await backup(database, stagingPath);
    database.close();
    database = undefined;

    assertDestinationIdentity(stagingPath, destinationIdentity);
    verifySqliteCopy(stagingPath);
    assertStagingSidecarsAbsent(stagingPath);
    const stagingHash = fileSha256(stagingPath);
    const syncDescriptor = fs.openSync(
      stagingPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try { fs.fsyncSync(syncDescriptor); } finally { fs.closeSync(syncDescriptor); }
    syncDirectory(stagingRoot);
    const currentParent = fs.lstatSync(parentIdentity.parent);
    if (!matchesIdentity(currentParent, parentIdentity)) {
      throw new Error('sqlite_copy_destination_parent_changed');
    }
    fs.linkSync(stagingPath, destination);
    published = true;
    assertDestinationIdentity(destination, destinationIdentity, { expectedLinks: 2 });
    assertDestinationIdentity(stagingPath, destinationIdentity, { expectedLinks: 2 });
    fs.unlinkSync(stagingPath);
    assertDestinationIdentity(destination, destinationIdentity);
    if (fileSha256(destination) !== stagingHash) throw new Error('sqlite_copy_publish_hash_mismatch');
    removeStagingDirectory(stagingRoot, stagingIdentity);
    syncDirectory(parentIdentity.parent);
  } catch (error) {
    if (database) database.close();
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      if (published && destinationIdentity) removeIdentityFile(destination, destinationIdentity);
      if (destinationIdentity) removeIdentityFile(stagingPath, destinationIdentity);
      removeStagingSidecars(stagingPath);
      removeStagingDirectory(stagingRoot, stagingIdentity);
    } catch { /* never replace the primary copy or publication failure */ }
    try { syncDirectory(parentIdentity.parent); } catch { /* preserve the primary failure */ }
    throw error;
  }
  return destination;
}
