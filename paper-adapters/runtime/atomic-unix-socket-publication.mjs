import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const PRIVATE_STAGING_DIRECTORY_MODE = 0o700;
const STALE_SOCKET_PROBE_TIMEOUT_MS = 250;

function fail(code, cause) {
  throw new Error(code, cause ? { cause } : undefined);
}

function currentUserId() {
  if (typeof process.geteuid === 'function') return BigInt(process.geteuid());
  if (typeof process.getuid === 'function') return BigInt(process.getuid());
  return null;
}

function currentGroupId() {
  if (typeof process.getegid === 'function') return BigInt(process.getegid());
  if (typeof process.getgid === 'function') return BigInt(process.getgid());
  return null;
}

function identity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(stat, expected) {
  return stat.dev === expected?.dev && stat.ino === expected?.ino;
}

function lstatIfPresent(candidate) {
  try { return fs.lstatSync(candidate, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertTrustedAncestorPermissions(parent, parentStat, owner) {
  let protectedChild = parentStat;
  let ancestor = path.dirname(parent);
  while (true) {
    const stat = fs.lstatSync(ancestor, { bigint: true });
    const trustedOwner = owner === null || stat.uid === owner || stat.uid === 0n;
    const otherPrincipalWritable = (stat.mode & 0o022n) !== 0n;
    const stickyProtectsChild = (stat.mode & 0o1000n) !== 0n
      && (owner === null || protectedChild.uid === owner || protectedChild.uid === 0n);
    if (!trustedOwner || (otherPrincipalWritable && !stickyProtectsChild)) {
      fail('atomic_unix_socket_parent_invalid');
    }
    if (ancestor === path.dirname(ancestor)) return;
    protectedChild = stat;
    ancestor = path.dirname(ancestor);
  }
}

function assertParentDirectory(parent, expectedIdentity = null) {
  const stat = fs.lstatSync(parent, { bigint: true });
  const owner = currentUserId();
  const group = currentGroupId();
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || fs.realpathSync(parent) !== parent
    || (owner !== null && stat.uid !== owner)
    || (group !== null && stat.gid !== group)
    || (stat.mode & 0o027n) !== 0n
    || (expectedIdentity && !sameIdentity(stat, expectedIdentity))) {
    fail('atomic_unix_socket_parent_invalid');
  }
  // realpathSync above rejects symlinked ancestors. The remaining chain must
  // not permit another principal to rename a component after validation. A
  // sticky shared directory is safe only when it protects the next component.
  assertTrustedAncestorPermissions(parent, stat, owner);
  return identity(stat);
}

function assertStagingDirectory(stagingRoot, expectedIdentity = null) {
  const stat = fs.lstatSync(stagingRoot, { bigint: true });
  const owner = currentUserId();
  const group = currentGroupId();
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || fs.realpathSync(stagingRoot) !== stagingRoot
    || (stat.mode & 0o777n) !== BigInt(PRIVATE_STAGING_DIRECTORY_MODE)
    || (owner !== null && stat.uid !== owner)
    || (group !== null && stat.gid !== group)
    || (expectedIdentity && !sameIdentity(stat, expectedIdentity))) {
    fail('atomic_unix_socket_staging_directory_invalid');
  }
  return identity(stat);
}

function assertSocket(candidate, {
  expectedIdentity = null,
  expectedLinks,
  expectedMode = null,
} = {}) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  const owner = currentUserId();
  const group = currentGroupId();
  if (!stat.isSocket()
    || stat.isSymbolicLink()
    || (owner !== null && stat.uid !== owner)
    || (group !== null && stat.gid !== group)
    || (expectedIdentity && !sameIdentity(stat, expectedIdentity))
    || (expectedLinks !== undefined && stat.nlink !== BigInt(expectedLinks))
    || (expectedMode !== null && (stat.mode & 0o777n) !== BigInt(expectedMode))) {
    fail('atomic_unix_socket_identity_invalid');
  }
  return identity(stat);
}

function probeExistingSocket(socketPath) {
  return new Promise((resolve) => {
    const client = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(result);
    };
    client.setTimeout(STALE_SOCKET_PROBE_TIMEOUT_MS, () => finish('uncertain'));
    client.once('connect', () => finish('active'));
    client.once('error', (error) => {
      if (error?.code === 'ECONNREFUSED') finish('stale');
      else if (error?.code === 'ENOENT') finish('absent');
      else finish('uncertain');
    });
  });
}

async function removeProvenStaleSocket(socketPath, parentIdentity) {
  const existing = lstatIfPresent(socketPath);
  if (!existing) return;
  const owner = currentUserId();
  const group = currentGroupId();
  if (!existing.isSocket()
    || existing.isSymbolicLink()
    || existing.nlink !== 1n
    || (owner !== null && existing.uid !== owner)
    || (group !== null && existing.gid !== group)) {
    fail('atomic_unix_socket_path_conflict');
  }
  const existingIdentity = identity(existing);
  const probe = await probeExistingSocket(socketPath);
  if (probe === 'absent' && !lstatIfPresent(socketPath)) return;
  if (probe !== 'stale') fail('atomic_unix_socket_path_conflict');
  assertParentDirectory(path.dirname(socketPath), parentIdentity);
  const current = lstatIfPresent(socketPath);
  if (!current
    || !current.isSocket()
    || current.nlink !== 1n
    || !sameIdentity(current, existingIdentity)) {
    fail('atomic_unix_socket_path_conflict');
  }
  // The validated parent excludes other principals. The systemd units also
  // serialize starts for a service identity; this last identity check limits
  // the remaining unlink race to a cooperating same-UID lifecycle.
  fs.unlinkSync(socketPath);
}

function removeIdentitySocket(candidate, expectedIdentity) {
  const stat = lstatIfPresent(candidate);
  if (!stat) return;
  if (!stat.isSocket() || !sameIdentity(stat, expectedIdentity)) {
    fail('atomic_unix_socket_cleanup_identity_mismatch');
  }
  fs.unlinkSync(candidate);
}

function removeIdentityDirectory(candidate, expectedIdentity) {
  const stat = lstatIfPresent(candidate);
  if (!stat) return;
  if (!stat.isDirectory() || !sameIdentity(stat, expectedIdentity)) {
    fail('atomic_unix_socket_cleanup_identity_mismatch');
  }
  fs.rmdirSync(candidate);
}

function removeProvisionalStagingSocket(candidate, stagingRoot, stagingIdentity) {
  if (!candidate || !stagingIdentity) return;
  assertStagingDirectory(stagingRoot, stagingIdentity);
  const stat = lstatIfPresent(candidate);
  if (!stat) return;
  const owner = currentUserId();
  const group = currentGroupId();
  if (!stat.isSocket()
    || stat.isSymbolicLink()
    || stat.nlink !== 1n
    || (owner !== null && stat.uid !== owner)
    || (group !== null && stat.gid !== group)) {
    fail('atomic_unix_socket_cleanup_identity_mismatch');
  }
  fs.unlinkSync(candidate);
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(socketPath);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) { reject(error); }
  });
}

async function rollback({
  server,
  listening,
  socketPath,
  socketIdentity,
  stagingPath,
  stagingRoot,
  stagingIdentity,
}) {
  let safeToUnlink = !listening;
  if (listening || server.listening) {
    try {
      await closeServer(server);
      safeToUnlink = true;
    } catch { /* an uncertain live listener must retain every pathname */ }
  }
  if (!safeToUnlink) return;
  try {
    if (socketIdentity) removeIdentitySocket(socketPath, socketIdentity);
  } catch { /* never remove a replacement or replace the publication failure */ }
  try {
    if (socketIdentity) removeIdentitySocket(stagingPath, socketIdentity);
    else removeProvisionalStagingSocket(stagingPath, stagingRoot, stagingIdentity);
  } catch { /* identity-bound best effort */ }
  try {
    if (stagingIdentity) removeIdentityDirectory(stagingRoot, stagingIdentity);
  } catch { /* identity-bound best effort */ }
}

export async function listenOnAtomicUnixSocket({
  server,
  socketPath,
  socketMode,
} = {}) {
  if (process.platform !== 'linux') {
    fail('atomic_unix_socket_platform_unsupported');
  }
  if (!server || typeof server.listen !== 'function' || typeof server.close !== 'function'
    || typeof server.once !== 'function' || typeof server.off !== 'function'
    || typeof socketPath !== 'string' || !path.isAbsolute(socketPath)
    || socketPath.includes('\0')
    || !Number.isSafeInteger(socketMode) || socketMode < 0 || socketMode > 0o777) {
    fail('atomic_unix_socket_configuration_invalid');
  }
  const selectedSocketPath = path.resolve(socketPath);
  const parent = path.dirname(selectedSocketPath);
  let parentIdentity;
  let stagingRoot;
  let stagingPath;
  let stagingIdentity;
  let socketIdentity;
  let listening = false;
  try {
    parentIdentity = assertParentDirectory(parent);
    await removeProvenStaleSocket(selectedSocketPath, parentIdentity);
    assertParentDirectory(parent, parentIdentity);
    stagingRoot = fs.mkdtempSync(path.join(parent, '.s-'));
    stagingIdentity = identity(fs.lstatSync(stagingRoot, { bigint: true }));
    assertStagingDirectory(stagingRoot, stagingIdentity);
    fs.chmodSync(stagingRoot, PRIVATE_STAGING_DIRECTORY_MODE);
    assertStagingDirectory(stagingRoot, stagingIdentity);
    stagingPath = path.join(stagingRoot, 's');
    await listen(server, stagingPath);
    listening = true;
    socketIdentity = assertSocket(stagingPath, { expectedLinks: 1 });
    fs.chmodSync(stagingPath, socketMode);
    assertSocket(stagingPath, {
      expectedIdentity: socketIdentity,
      expectedLinks: 1,
      expectedMode: socketMode,
    });
    assertParentDirectory(parent, parentIdentity);
    assertStagingDirectory(stagingRoot, stagingIdentity);
    try { fs.linkSync(stagingPath, selectedSocketPath); }
    catch (error) {
      if (error?.code === 'EEXIST') fail('atomic_unix_socket_path_conflict', error);
      fail('atomic_unix_socket_hard_link_publication_unsupported', error);
    }
    assertSocket(stagingPath, {
      expectedIdentity: socketIdentity,
      expectedLinks: 2,
      expectedMode: socketMode,
    });
    assertSocket(selectedSocketPath, {
      expectedIdentity: socketIdentity,
      expectedLinks: 2,
      expectedMode: socketMode,
    });
    fs.unlinkSync(stagingPath);
    assertSocket(selectedSocketPath, {
      expectedIdentity: socketIdentity,
      expectedLinks: 1,
      expectedMode: socketMode,
    });
    removeIdentityDirectory(stagingRoot, stagingIdentity);
    stagingIdentity = null;
  } catch (error) {
    await rollback({
      server,
      listening,
      socketPath: selectedSocketPath,
      socketIdentity,
      stagingPath,
      stagingRoot,
      stagingIdentity,
    });
    if (String(error?.message || '').startsWith('atomic_unix_socket_')) throw error;
    fail('atomic_unix_socket_publication_failed', error);
  }
  let closePromise = null;
  server.once('close', () => {
    try { removeIdentitySocket(selectedSocketPath, socketIdentity); }
    catch { /* raw server.close() must never remove a replacement inode */ }
  });
  return Object.freeze({
    socketPath: selectedSocketPath,
    identity: socketIdentity,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let closeError = null;
        try { await closeServer(server); }
        catch (error) { closeError = error; }
        try { removeIdentitySocket(selectedSocketPath, socketIdentity); }
        catch (error) {
          if (!closeError) closeError = error;
        }
        if (closeError) throw closeError;
      })();
      return closePromise;
    },
  });
}
