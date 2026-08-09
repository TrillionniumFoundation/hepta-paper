import fs from 'node:fs';

import {
  assertPinnedCasOwnedDirectory,
  assertPinnedCasPublishedFile,
  closePinnedCasDirectoryChain,
  errorCausedByCode,
  hashPinnedCasFile,
  openPinnedCasChildDirectory,
  openPinnedCasRegularFile,
} from './cold-volume-cas-path-boundary.mjs';

function unique(values) { return [...new Set(values)]; }

export function closePinnedCasObjectInspection(inspection) {
  for (const inspected of inspection?.inspectedObjects || []) {
    if (inspected.pinned?.descriptor !== undefined) {
      try { fs.closeSync(inspected.pinned.descriptor); } catch { /* Already closed. */ }
    }
  }
  closePinnedCasDirectoryChain(inspection?.shardDirectories);
  closePinnedCasDirectoryChain(
    inspection?.objectsDirectory ? [inspection.objectsDirectory] : null,
  );
}

export function inspectPinnedCasObjects(entries, casRootChain) {
  const blockers = [];
  const inspectedObjects = [];
  let objectsDirectory;
  const shardDirectories = [];
  const shards = new Map();
  try {
    objectsDirectory = openPinnedCasChildDirectory(casRootChain.at(-1), 'objects', {
      errorCode: 'cold_volume_cas_object_unsafe',
    });
    assertPinnedCasOwnedDirectory(
      casRootChain.at(-1), objectsDirectory, 'cold_volume_cas_object_unsafe',
    );
  } catch (error) {
    const suffix = errorCausedByCode(error, 'ENOENT') ? 'missing' : 'unsafe';
    return Object.freeze({
      blockers: entries.map((entry) => `cold_volume_cas_object_${suffix}:${entry.relative}`),
      inspectedObjects,
      objectsDirectory: null,
      shardDirectories,
    });
  }
  for (const entry of entries) {
    const token = String(entry.objectHash).replace(/^sha256:/, '');
    let pinned;
    try {
      let shardDirectory = shards.get(token.slice(0, 2));
      if (!shardDirectory) {
        shardDirectory = openPinnedCasChildDirectory(objectsDirectory, token.slice(0, 2), {
          errorCode: 'cold_volume_cas_object_unsafe',
        });
        assertPinnedCasOwnedDirectory(
          casRootChain.at(-1), shardDirectory, 'cold_volume_cas_object_unsafe',
        );
        shards.set(token.slice(0, 2), shardDirectory);
        shardDirectories.push(shardDirectory);
      }
      const directoryChain = Object.freeze([
        ...casRootChain,
        objectsDirectory,
        shardDirectory,
      ]);
      pinned = openPinnedCasRegularFile(null, 'cold_volume_cas_object_unsafe', {
        directoryChain,
        name: `${token}.tar.gz`,
      });
      assertPinnedCasPublishedFile(pinned, 'cold_volume_cas_object_unsafe');
      if (pinned.identity.size !== String(entry.bytes)) {
        blockers.push(`cold_volume_cas_object_size_mismatch:${entry.relative}`);
      }
      if (hashPinnedCasFile(
        pinned, 'cold_volume_cas_object_changed_during_read',
      ) !== entry.objectHash) {
        blockers.push(`cold_volume_cas_object_hash_mismatch:${entry.relative}`);
      }
      inspectedObjects.push(Object.freeze({ directoryChain, entry, pinned }));
    } catch (error) {
      if (pinned?.descriptor !== undefined) fs.closeSync(pinned.descriptor);
      const suffix = !pinned && errorCausedByCode(error, 'ENOENT') ? 'missing' : 'unsafe';
      blockers.push(`cold_volume_cas_object_${suffix}:${entry.relative}`);
    }
  }
  return Object.freeze({
    blockers: unique(blockers), inspectedObjects, objectsDirectory, shardDirectories,
  });
}

export function pinnedCasObjectBindingBlockers(inspection) {
  const blockers = [];
  for (const inspected of inspection?.inspectedObjects || []) {
    try {
      assertPinnedCasPublishedFile(inspected.pinned, 'cold_volume_cas_object_unsafe');
      if (hashPinnedCasFile(
        inspected.pinned, 'cold_volume_cas_object_changed_during_read',
      ) !== inspected.entry.objectHash) {
        blockers.push(`cold_volume_cas_object_hash_mismatch:${inspected.entry.relative}`);
      }
    } catch {
      blockers.push(`cold_volume_cas_object_unsafe:${inspected.entry.relative}`);
    }
  }
  return unique(blockers);
}
