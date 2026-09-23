import fs from 'node:fs';
import path from 'node:path';

export function snapshotImmutableArchiveDirectoryChain(directory, fileSystem = fs) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const snapshots = [];
  for (const component of [null, ...absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)]) {
    if (component !== null) current = path.join(current, component);
    const stat = fileSystem.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('legacy_immutable_snapshot_archive_parent_unsafe');
    }
    snapshots.push(Object.freeze({
      path: current,
      dev: stat.dev,
      ino: stat.ino,
    }));
  }
  return Object.freeze(snapshots);
}

export function immutableArchiveDirectoryChainUnchanged(snapshot, fileSystem = fs) {
  return snapshot.every((expected) => {
    try {
      const actual = fileSystem.lstatSync(expected.path);
      return actual.isDirectory() && !actual.isSymbolicLink()
        && actual.dev === expected.dev && actual.ino === expected.ino;
    } catch { return false; }
  });
}

export function selectedDirectorySnapshot(directory, fileSystem = fs) {
  const stat = fileSystem.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('legacy_immutable_snapshot_root_unsafe');
  }
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function sameSelectedDirectorySnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function selectedDirectoryUnchanged(directory, expected, fileSystem = fs) {
  try {
    const actual = selectedDirectorySnapshot(directory, fileSystem);
    return sameSelectedDirectorySnapshot(actual, expected);
  } catch { return false; }
}

export function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function selectedDirectoryEntrySnapshot(directory, fileSystem = fs) {
  const before = selectedDirectorySnapshot(directory, fileSystem);
  const entries = Object.freeze([...fileSystem.readdirSync(directory)].sort());
  const after = selectedDirectorySnapshot(directory, fileSystem);
  if (!sameSelectedDirectorySnapshot(before, after)) {
    throw new Error('release_evidence_selection_directory_changed_during_scan');
  }
  return Object.freeze({ ...after, entries });
}

export function selectedDirectoryEntriesUnchanged(directory, expected, fileSystem = fs) {
  try {
    const actual = selectedDirectoryEntrySnapshot(directory, fileSystem);
    return sameSelectedDirectorySnapshot(actual, expected)
      && sameStringArray(actual.entries, expected.entries);
  } catch { return false; }
}
