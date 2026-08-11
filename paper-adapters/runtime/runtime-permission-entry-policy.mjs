export function octalMode(mode) {
  return (Number(mode) & 0o7777).toString(8).padStart(4, '0');
}

export function modeNumber(stat) {
  return Number(stat.mode & 0o7777n);
}

export function typeOf(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'regular_file';
  if (stat.isSymbolicLink()) return 'symbolic_link';
  if (stat.isSocket()) return 'socket';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isBlockDevice()) return 'block_device';
  if (stat.isCharacterDevice()) return 'character_device';
  return 'unknown';
}

export function identityOf(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    type: typeOf(stat),
    linkCount: Number(stat.nlink),
    ownerId: String(stat.uid),
    groupId: String(stat.gid),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameDataAndOwnershipIdentity(identity, stat) {
  return identity.device === String(stat.dev)
    && identity.inode === String(stat.ino)
    && identity.type === typeOf(stat)
    && identity.linkCount === Number(stat.nlink)
    && identity.ownerId === String(stat.uid)
    && identity.groupId === String(stat.gid)
    && identity.size === Number(stat.size)
    && identity.mtimeNs === String(stat.mtimeNs);
}

export function sameCompleteIdentity(identity, stat) {
  return sameDataAndOwnershipIdentity(identity, stat)
    && identity.ctimeNs === String(stat.ctimeNs);
}

export function sameIdentityAfterModeChange(identity, stat) {
  return sameDataAndOwnershipIdentity(identity, stat);
}

function targetModeFor(stat) {
  if (stat.isDirectory()) return 0o700;
  const currentMode = modeNumber(stat);
  const executable = (currentMode & 0o111) !== 0;
  const writable = (currentMode & 0o222) !== 0;
  if (executable) return writable ? 0o700 : 0o500;
  return writable ? 0o600 : 0o400;
}

export function permissionRecord(
  relativePath,
  stat,
  { preserveCurrentMode = false } = {},
) {
  const currentMode = modeNumber(stat);
  const targetMode = preserveCurrentMode ? currentMode : targetModeFor(stat);
  return Object.freeze({
    relativePath,
    type: typeOf(stat),
    currentMode: octalMode(currentMode),
    targetMode: octalMode(targetMode),
    identity: identityOf(stat),
  });
}
