import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import { verifyColdVolumeContract } from './cold-volume-contract.mjs';
import {
  assertPinnedCasDirectoryChain,
  assertPinnedCasFileCurrent,
  assertPinnedCasOwnedDirectory,
  assertPinnedCasPublishedFile,
  closePinnedCasDirectoryChain,
  errorCausedByCode,
  hashPinnedCasFile,
  openPinnedCasAbsoluteDirectoryChain,
  openPinnedCasChildDirectory,
  openPinnedCasJsonRecord,
  openPinnedCasRegularFile,
  readPinnedCasJsonRecord,
} from './cold-volume-cas-path-boundary.mjs';
import {
  closePinnedCasObjectInspection,
  inspectPinnedCasObjects,
  pinnedCasObjectBindingBlockers,
} from './cold-volume-cas-object-inspection.mjs';
import {
  publishPinnedCasBytes,
  publishPinnedCasSourceFile,
  replacePinnedCasBytes,
} from './cold-volume-cas-publication-repository.mjs';
import {
  inspectPinnedCasArchiveListing,
  inspectRestoredCasEntryInventory,
} from './cold-volume-cas-restore-boundary.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CURRENT_POINTER_KEYS = Object.freeze(['kind', 'manifestHash', 'version']);
const MANIFEST_KEYS = Object.freeze([
  'contractHash', 'contractId', 'entries', 'entryCount', 'kind', 'manifestHash', 'version',
]);
const MANIFEST_ENTRY_KEYS = Object.freeze(['bytes', 'objectHash', 'relative']);

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function unique(values) { return [...new Set(values)]; }

function hasControlCharacter(value) {
  return [...String(value)].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')
    || hasControlCharacter(value) || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function overlappingRelatives(values) {
  const sorted = [...values].sort();
  return sorted.some((relative, index) => sorted.some((other, otherIndex) => (
    index !== otherIndex && other.startsWith(`${relative}/`)
  )));
}

function currentManifest(casRootChain, casRoot) {
  let manifestDirectory;
  let openedManifest;
  let openedPointer;
  try {
    try {
      manifestDirectory = openPinnedCasChildDirectory(casRootChain.at(-1), 'manifests', {
        errorCode: 'cold_volume_cas_manifest_root_unsafe',
      });
      assertPinnedCasOwnedDirectory(
        casRootChain.at(-1), manifestDirectory, 'cold_volume_cas_manifest_root_unsafe',
      );
    } catch (error) {
      if (errorCausedByCode(error, 'ENOENT')) return null;
      throw error;
    }
    const chain = Object.freeze([...casRootChain, manifestDirectory]);
    try {
      openedPointer = openPinnedCasJsonRecord(
        null,
        'cold_volume_cas_current_pointer_unsafe_or_invalid',
        { directoryChain: chain, name: 'current.json', requirePublished: true },
      );
    } catch (error) {
      if (!errorCausedByCode(error, 'ENOENT')) throw error;
      closePinnedCasDirectoryChain([manifestDirectory]);
      manifestDirectory = null;
      return null;
    }
    const pointer = openedPointer.document;
    if (!exactKeys(pointer, CURRENT_POINTER_KEYS)
      || pointer.version !== 1
      || pointer.kind !== 'ColdVolumeCasCurrentManifest'
      || !SHA256.test(String(pointer.manifestHash || ''))) {
      throw new Error('cold_volume_cas_current_pointer_unsafe_or_invalid');
    }
    const name = `${pointer.manifestHash.slice('sha256:'.length)}.json`;
    const manifestPath = path.join(path.resolve(casRoot), 'manifests', name);
    openedManifest = openPinnedCasJsonRecord(
      null,
      'cold_volume_cas_manifest_unsafe_or_invalid',
      { directoryChain: chain, name, requirePublished: true },
    );
    assertPinnedCasFileCurrent(
      openedManifest.pinned,
      'cold_volume_cas_manifest_unsafe_or_invalid',
    );
    return Object.freeze({
      manifest: openedManifest.document,
      manifestDirectory,
      manifestPath,
      manifestPinned: openedManifest.pinned,
      pointerPinned: openedPointer.pinned,
    });
  } catch (error) {
    if (openedManifest?.pinned?.descriptor !== undefined) {
      try { fs.closeSync(openedManifest.pinned.descriptor); } catch { /* Already closed. */ }
    }
    if (openedPointer?.pinned?.descriptor !== undefined) {
      try { fs.closeSync(openedPointer.pinned.descriptor); } catch { /* Already closed. */ }
    }
    closePinnedCasDirectoryChain(manifestDirectory ? [manifestDirectory] : null);
    throw error;
  }
}

function closeSelectedManifest(selectedManifest) {
  if (selectedManifest?.manifestPinned?.descriptor !== undefined) {
    try { fs.closeSync(selectedManifest.manifestPinned.descriptor); } catch { /* Already closed. */ }
  }
  if (selectedManifest?.pointerPinned?.descriptor !== undefined) {
    try { fs.closeSync(selectedManifest.pointerPinned.descriptor); } catch { /* Already closed. */ }
  }
  closePinnedCasDirectoryChain(
    selectedManifest?.manifestDirectory ? [selectedManifest.manifestDirectory] : null,
  );
}

function closeInspection(inspection) {
  closePinnedCasObjectInspection(inspection?.objectInspection);
  closeSelectedManifest(inspection?.selectedManifest);
  closePinnedCasDirectoryChain(inspection?.casRootChain);
}

function selectedManifestBindingBlockers(selectedManifest) {
  if (!selectedManifest) return [];
  try {
    assertPinnedCasPublishedFile(
      selectedManifest.pointerPinned,
      'cold_volume_cas_current_pointer_unsafe_or_invalid',
    );
    assertPinnedCasPublishedFile(
      selectedManifest.manifestPinned,
      'cold_volume_cas_manifest_unsafe_or_invalid',
    );
    return [];
  } catch (error) {
    return [error.message];
  }
}

function expectedContractBinding({ contract, contractPath = null, contractHash = null } = {}) {
  const blockers = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)
    || contract.version !== 1 || contract.kind !== 'ColdVolumeMountContract'
    || typeof contract.contractId !== 'string' || !contract.contractId
    || hasControlCharacter(contract.contractId)) {
    blockers.push('cold_volume_cas_contract_schema_invalid');
  }
  const entries = Array.isArray(contract?.entries) ? contract.entries : [];
  if (!entries.length) blockers.push('cold_volume_cas_contract_entries_empty');
  if (entries.some((relative) => !safeRelative(relative))) {
    blockers.push('cold_volume_cas_contract_entry_relative_invalid');
  }
  if (new Set(entries).size !== entries.length) {
    blockers.push('cold_volume_cas_contract_entry_relative_duplicate');
  }
  if (overlappingRelatives(entries)) blockers.push('cold_volume_cas_contract_entry_overlap');
  let resolvedHash = contractHash;
  if (resolvedHash === null && contractPath) {
    try {
      const file = readPinnedCasJsonRecord(
        contractPath,
        'cold_volume_cas_contract_file_unsafe',
      );
      if (hashRecord('ColdVolumeMountContract', file.document)
        !== hashRecord('ColdVolumeMountContract', contract)) {
        blockers.push('cold_volume_cas_contract_file_mismatch');
      }
      resolvedHash = file.fileHash;
    } catch {
      blockers.push('cold_volume_cas_contract_file_unsafe');
    }
  }
  if (resolvedHash === null && contract && typeof contract === 'object') {
    resolvedHash = hashRecord('ColdVolumeMountContract', contract);
  }
  if (!SHA256.test(String(resolvedHash || ''))) {
    blockers.push('cold_volume_cas_contract_hash_invalid');
  }
  return Object.freeze({
    blockers: unique(blockers),
    contractHash: resolvedHash || null,
    contractId: contract?.contractId || null,
    entries: [...entries].sort(),
  });
}

function validateManifest({ manifest, manifestPath, binding }) {
  const blockers = [...binding.blockers];
  if (!exactKeys(manifest, MANIFEST_KEYS)) blockers.push('cold_volume_cas_manifest_schema_invalid');
  if (manifest?.version !== 1 || manifest?.kind !== 'ColdVolumeCasManifest') {
    blockers.push('cold_volume_cas_manifest_contract_invalid');
  }
  if (manifest?.contractId !== binding.contractId
    || manifest?.contractHash !== binding.contractHash) {
    blockers.push('cold_volume_cas_manifest_contract_binding_mismatch');
  }
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  if (!entries.length) blockers.push('cold_volume_cas_manifest_entries_empty');
  if (!Number.isSafeInteger(manifest?.entryCount)
    || manifest.entryCount !== entries.length) blockers.push('cold_volume_cas_manifest_entry_count_invalid');
  const relatives = [];
  for (const entry of entries) {
    if (!exactKeys(entry, MANIFEST_ENTRY_KEYS)) blockers.push('cold_volume_cas_manifest_entry_schema_invalid');
    if (!safeRelative(entry?.relative)) blockers.push('cold_volume_cas_manifest_entry_relative_invalid');
    else relatives.push(entry.relative);
    if (!SHA256.test(String(entry?.objectHash || ''))) blockers.push('cold_volume_cas_manifest_object_hash_invalid');
    if (!Number.isSafeInteger(entry?.bytes) || entry.bytes <= 0) {
      blockers.push('cold_volume_cas_manifest_object_size_invalid');
    }
  }
  if (new Set(relatives).size !== relatives.length) {
    blockers.push('cold_volume_cas_manifest_entry_relative_duplicate');
  }
  if (overlappingRelatives(relatives)) blockers.push('cold_volume_cas_manifest_entry_overlap');
  if (JSON.stringify([...relatives].sort()) !== JSON.stringify(binding.entries)) {
    blockers.push('cold_volume_cas_manifest_inventory_mismatch');
  }
  const payload = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'manifestHash'))
    : null;
  if (!SHA256.test(String(manifest?.manifestHash || '')) || !payload
    || hashRecord('ColdVolumeCasManifest', payload) !== manifest.manifestHash) {
    blockers.push('cold_volume_cas_manifest_hash_invalid');
  }
  if (SHA256.test(String(manifest?.manifestHash || ''))
    && path.basename(manifestPath) !== `${manifest.manifestHash.slice('sha256:'.length)}.json`) {
    blockers.push('cold_volume_cas_manifest_filename_mismatch');
  }
  return Object.freeze({ blockers: unique(blockers), entries });
}

function inspectColdVolumeCas({
  afterManifestRead = null,
  casRoot,
  contract,
  contractPath = null,
  contractHash = null,
} = {}) {
  let casRootChain;
  try {
    casRootChain = openPinnedCasAbsoluteDirectoryChain(casRoot, {
      errorCode: 'cold_volume_cas_root_unsafe',
    });
  } catch (error) {
    const missing = errorCausedByCode(error, 'ENOENT');
    return Object.freeze({
      casRootChain: null,
      manifest: null,
      objectInspection: null,
      selectedManifest: null,
      status: Object.freeze({
        version: 1,
        kind: 'ColdVolumeCasStatus',
        status: missing ? 'cold_volume_cas_manifest_missing' : 'cold_volume_cas_blocked',
        casRoot,
        manifestPath: null,
        objectCount: 0,
        blockers: [missing ? 'cold_volume_cas_manifest_missing' : error.message],
      }),
    });
  }
  try {
    assertPinnedCasOwnedDirectory(
      casRootChain.at(-1), casRootChain.at(-1), 'cold_volume_cas_root_unsafe',
    );
  } catch (error) {
    return Object.freeze({
      casRootChain,
      manifest: null,
      objectInspection: null,
      selectedManifest: null,
      status: Object.freeze({
        version: 1,
        kind: 'ColdVolumeCasStatus',
        status: 'cold_volume_cas_blocked',
        casRoot,
        manifestPath: null,
        objectCount: 0,
        blockers: [error.message],
      }),
    });
  }
  let selectedManifest;
  try { selectedManifest = currentManifest(casRootChain, casRoot); }
  catch (error) {
    return Object.freeze({
      casRootChain,
      manifest: null,
      objectInspection: null,
      selectedManifest: null,
      status: Object.freeze({
        version: 1,
        kind: 'ColdVolumeCasStatus',
        status: 'cold_volume_cas_blocked',
        casRoot,
        manifestPath: null,
        objectCount: 0,
        blockers: [error.message],
      }),
    });
  }
  if (!selectedManifest) {
    return Object.freeze({
      casRootChain,
      manifest: null,
      objectInspection: null,
      selectedManifest: null,
      status: Object.freeze({
        version: 1,
        kind: 'ColdVolumeCasStatus',
        status: 'cold_volume_cas_manifest_missing',
        casRoot,
        manifestPath: null,
        objectCount: 0,
        blockers: ['cold_volume_cas_manifest_missing'],
      }),
    });
  }
  let objectInspection;
  try {
    if (afterManifestRead !== null) {
      if (typeof afterManifestRead !== 'function') throw new Error('cold_volume_cas_hook_invalid');
      afterManifestRead();
    }
    const { manifest, manifestPath } = selectedManifest;
    const binding = expectedContractBinding({ contract, contractHash, contractPath });
    const validation = validateManifest({ binding, manifest, manifestPath });
    const blockers = [
      ...validation.blockers,
      ...selectedManifestBindingBlockers(selectedManifest),
    ];
    if (!blockers.length) {
      objectInspection = inspectPinnedCasObjects(validation.entries, casRootChain);
      blockers.push(...objectInspection.blockers);
    }
    blockers.push(...pinnedCasObjectBindingBlockers(objectInspection));
    blockers.push(...selectedManifestBindingBlockers(selectedManifest));
    const status = Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasStatus',
      status: blockers.length ? 'cold_volume_cas_blocked' : 'cold_volume_cas_ready',
      casRoot,
      manifestPath,
      manifestHash: manifest.manifestHash || null,
      contractHash: manifest.contractHash || null,
      contractId: manifest.contractId || null,
      entryCount: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
      objectCount: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
      blockers: unique(blockers),
    });
    return Object.freeze({
      casRootChain, manifest, objectInspection, selectedManifest, status,
    });
  } catch (error) {
    closePinnedCasObjectInspection(objectInspection);
    closeSelectedManifest(selectedManifest);
    closePinnedCasDirectoryChain(casRootChain);
    throw error;
  }
}

export function coldVolumeCasStatus(options = {}) {
  const inspection = inspectColdVolumeCas(options);
  try { return inspection.status; }
  finally { closeInspection(inspection); }
}

export function importColdVolumeToCas({ assetRoot, contract, contractPath, casRoot, execute = false, mountAvailableOverride = null } = {}) {
  const binding = expectedContractBinding({ contract, contractPath });
  let contractStatus;
  try {
    contractStatus = verifyColdVolumeContract({ assetRoot, contract, contractPath, mountAvailableOverride });
  } catch {
    contractStatus = Object.freeze({
      version: 1,
      kind: 'ColdVolumeMountContractStatus',
      operationalReplayReady: false,
      blockers: ['cold_volume_contract_invalid'],
    });
  }
  const blockers = [...binding.blockers, ...contractStatus.blockers];
  if (!execute) blockers.push('cold_volume_cas_import_execute_required');
  if (!contractStatus.operationalReplayReady) blockers.push('cold_volume_operational_replay_not_ready');
  if (blockers.length) {
    return Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasImportReceipt',
      status: 'cold_volume_cas_import_blocked',
      execute,
      casRoot,
      contractStatus,
      importedObjectCount: 0,
      externalActionPerformed: false,
      blockers: unique(blockers),
    });
  }
  const contentRoot = path.join(path.resolve(contract.mountRoot), contract.contentRoot);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-import-'));
  const entries = [];
  let casRootChain;
  let manifestDirectory;
  let manifestChain;
  let manifestPinned;
  let objectsDirectory;
  let pointerPinned;
  const publishedObjects = [];
  const shardDirectories = [];
  try {
    casRootChain = openPinnedCasAbsoluteDirectoryChain(casRoot, {
      create: true,
      errorCode: 'cold_volume_cas_import_root_unsafe',
    });
    assertPinnedCasOwnedDirectory(
      casRootChain.at(-1), casRootChain.at(-1), 'cold_volume_cas_import_root_unsafe',
    );
    objectsDirectory = openPinnedCasChildDirectory(casRootChain.at(-1), 'objects', {
      create: true,
      errorCode: 'cold_volume_cas_import_object_unsafe',
    });
    assertPinnedCasOwnedDirectory(
      casRootChain.at(-1), objectsDirectory, 'cold_volume_cas_import_object_unsafe',
    );
    for (const relative of [...contract.entries].sort()) {
      const tempArchive = path.join(tempRoot, `${crypto.randomUUID()}.tar.gz`);
      const tar = spawnSync('tar', [
        '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
        '-czf', tempArchive, '-C', contentRoot, '--', relative,
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (tar.status !== 0) throw new Error(tar.stderr || `cold_volume_cas_archive_failed:${relative}`);
      const objectHash = sha256FileSync(tempArchive);
      const token = objectHash.slice('sha256:'.length);
      let shardDirectory;
      shardDirectory = openPinnedCasChildDirectory(objectsDirectory, token.slice(0, 2), {
        create: true,
        errorCode: 'cold_volume_cas_import_object_unsafe',
      });
      shardDirectories.push(shardDirectory);
      assertPinnedCasOwnedDirectory(
        casRootChain.at(-1), shardDirectory, 'cold_volume_cas_import_object_unsafe',
      );
      const objectChain = Object.freeze([
        ...casRootChain,
        objectsDirectory,
        shardDirectory,
      ]);
      const objectName = `${token}.tar.gz`;
      const identity = publishPinnedCasSourceFile(
        objectChain,
        objectName,
        tempArchive,
        objectHash,
        'cold_volume_cas_import_object_unsafe',
      );
      const pinned = openPinnedCasRegularFile(
        null,
        'cold_volume_cas_import_object_unsafe',
        { directoryChain: objectChain, name: objectName },
      );
      assertPinnedCasPublishedFile(pinned, 'cold_volume_cas_import_object_unsafe');
      if (hashPinnedCasFile(pinned, 'cold_volume_cas_import_object_unsafe') !== objectHash) {
        fs.closeSync(pinned.descriptor);
        throw new Error('cold_volume_cas_import_object_unsafe');
      }
      publishedObjects.push(Object.freeze({
        expectedFileHash: objectHash,
        name: objectName,
        objectChain,
        pinned,
      }));
      entries.push({ relative, objectHash, bytes: Number(identity.size) });
    }
    const payload = {
      version: 1,
      kind: 'ColdVolumeCasManifest',
      contractId: contract.contractId,
      contractHash: binding.contractHash,
      entryCount: entries.length,
      entries,
    };
    const manifest = { ...payload, manifestHash: hashRecord('ColdVolumeCasManifest', payload) };
    const manifestName = `${manifest.manifestHash.replace(/^sha256:/, '')}.json`;
    const manifestPath = path.join(path.resolve(casRoot), 'manifests', manifestName);
    manifestDirectory = openPinnedCasChildDirectory(casRootChain.at(-1), 'manifests', {
      create: true,
      errorCode: 'cold_volume_cas_import_manifest_unsafe',
    });
    assertPinnedCasOwnedDirectory(
      casRootChain.at(-1), manifestDirectory, 'cold_volume_cas_import_manifest_unsafe',
    );
    manifestChain = Object.freeze([...casRootChain, manifestDirectory]);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    publishPinnedCasBytes(
      manifestChain,
      manifestName,
      manifestBytes,
      'cold_volume_cas_import_manifest_unsafe',
    );
    manifestPinned = openPinnedCasRegularFile(
      null,
      'cold_volume_cas_import_manifest_unsafe',
      { directoryChain: manifestChain, name: manifestName },
    );
    assertPinnedCasPublishedFile(manifestPinned, 'cold_volume_cas_import_manifest_unsafe');
    const pointer = Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasCurrentManifest',
      manifestHash: manifest.manifestHash,
    });
    const pointerBytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`);
    replacePinnedCasBytes(
      manifestChain,
      'current.json',
      pointerBytes,
      'cold_volume_cas_import_pointer_unsafe',
    );
    pointerPinned = openPinnedCasRegularFile(
      null,
      'cold_volume_cas_import_pointer_unsafe',
      { directoryChain: manifestChain, name: 'current.json' },
    );
    assertPinnedCasPublishedFile(pointerPinned, 'cold_volume_cas_import_pointer_unsafe');
    for (const published of publishedObjects) {
      assertPinnedCasPublishedFile(published.pinned, 'cold_volume_cas_import_object_unsafe');
      if (hashPinnedCasFile(
        published.pinned, 'cold_volume_cas_import_object_unsafe',
      ) !== published.expectedFileHash) throw new Error('cold_volume_cas_import_object_unsafe');
    }
    assertPinnedCasPublishedFile(manifestPinned, 'cold_volume_cas_import_manifest_unsafe');
    if (hashPinnedCasFile(
      manifestPinned, 'cold_volume_cas_import_manifest_unsafe',
    ) !== `sha256:${crypto.createHash('sha256').update(manifestBytes).digest('hex')}`) {
      throw new Error('cold_volume_cas_import_manifest_unsafe');
    }
    assertPinnedCasPublishedFile(pointerPinned, 'cold_volume_cas_import_pointer_unsafe');
    if (hashPinnedCasFile(
      pointerPinned, 'cold_volume_cas_import_pointer_unsafe',
    ) !== `sha256:${crypto.createHash('sha256').update(pointerBytes).digest('hex')}`) {
      throw new Error('cold_volume_cas_import_pointer_unsafe');
    }
    for (const directory of shardDirectories) fs.fsyncSync(directory.descriptor);
    fs.fsyncSync(objectsDirectory.descriptor);
    fs.fsyncSync(manifestDirectory.descriptor);
    fs.fsyncSync(casRootChain.at(-1).descriptor);
    assertPinnedCasDirectoryChain(manifestChain, 'cold_volume_cas_import_manifest_unsafe');
    return Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasImportReceipt',
      status: 'cold_volume_cas_imported',
      execute: true,
      casRoot,
      manifestPath,
      manifestHash: manifest.manifestHash,
      importedObjectCount: entries.length,
      externalActionPerformed: false,
      blockers: [],
    });
  } finally {
    if (pointerPinned?.descriptor !== undefined) fs.closeSync(pointerPinned.descriptor);
    if (manifestPinned?.descriptor !== undefined) fs.closeSync(manifestPinned.descriptor);
    for (const published of publishedObjects) {
      if (published.pinned?.descriptor !== undefined) fs.closeSync(published.pinned.descriptor);
    }
    closePinnedCasDirectoryChain(manifestDirectory ? [manifestDirectory] : null);
    closePinnedCasDirectoryChain(shardDirectories);
    closePinnedCasDirectoryChain(objectsDirectory ? [objectsDirectory] : null);
    closePinnedCasDirectoryChain(casRootChain);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function drillColdVolumeCasRestore(options = {}) {
  const { casRoot } = options;
  const inspection = inspectColdVolumeCas(options);
  const { status } = inspection;
  let restoreRoot;
  const blockers = [];
  let restoredObjectCount = 0;
  try {
    if (status.status !== 'cold_volume_cas_ready') {
      return Object.freeze({
        version: 1,
        kind: 'ColdVolumeCasRestoreDrillReceipt',
        status: 'cold_volume_cas_restore_drill_blocked',
        casRoot,
        restoredObjectCount: 0,
        blockers: status.blockers,
      });
    }
    const manifest = inspection.manifest;
    const inspectedByRelative = new Map(
      inspection.objectInspection.inspectedObjects.map((row) => [row.entry.relative, row]),
    );
    restoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-restore-'));
    for (const entry of manifest.entries) {
      const inspected = inspectedByRelative.get(entry.relative);
      if (!inspected?.pinned) {
        blockers.push(`cold_volume_cas_object_unsafe:${entry.relative}`);
        continue;
      }
      const listingBlockers = inspectPinnedCasArchiveListing(inspected.pinned, entry.relative);
      if (listingBlockers.length) {
        blockers.push(...listingBlockers);
        continue;
      }
      const entryRoot = fs.mkdtempSync(path.join(restoreRoot, 'entry-'));
      try {
        const extract = spawnSync('tar', [
          '--extract', '--gzip', '--file=/proc/self/fd/3', `--directory=${entryRoot}`,
          '--no-same-owner', '--no-same-permissions', '--delay-directory-restore',
        ], {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe', inspected.pinned.descriptor],
        });
        assertPinnedCasFileCurrent(
          inspected.pinned,
          'cold_volume_cas_object_changed_during_restore',
        );
        const inventoryBlockers = extract.status === 0
          ? inspectRestoredCasEntryInventory(entryRoot, entry.relative)
          : [`cold_volume_cas_restore_failed:${entry.relative}`];
        if (inventoryBlockers.length) blockers.push(...inventoryBlockers);
        else restoredObjectCount += 1;
      } catch {
        blockers.push(`cold_volume_cas_restore_failed:${entry.relative}`);
      }
    }
    blockers.push(...pinnedCasObjectBindingBlockers(inspection.objectInspection));
    blockers.push(...selectedManifestBindingBlockers(inspection.selectedManifest));
    if (restoredObjectCount !== manifest.entryCount) {
      blockers.push('cold_volume_cas_restore_exact_inventory_incomplete');
    }
    return Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasRestoreDrillReceipt',
      status: blockers.length ? 'cold_volume_cas_restore_drill_blocked' : 'cold_volume_cas_restore_drill_passed',
      casRoot,
      manifestHash: manifest.manifestHash,
      contractHash: manifest.contractHash,
      contractId: manifest.contractId,
      expectedObjectCount: manifest.entryCount,
      restoredObjectCount,
      blockers: unique(blockers),
    });
  } finally {
    if (restoreRoot) fs.rmSync(restoreRoot, { recursive: true, force: true });
    closeInspection(inspection);
  }
}
