import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const INVENTORY_KEYS = Object.freeze([
  'version', 'kind', 'entries', 'fileCount', 'directoryCount', 'totalBytes',
  'packageRecoveryTreeInventoryHash',
]);
const DIRECTORY_ENTRY_KEYS = Object.freeze([
  'path', 'kind', 'posixMode', 'uid', 'gid',
]);
const FILE_ENTRY_KEYS = Object.freeze([
  ...DIRECTORY_ENTRY_KEYS, 'bytes', 'bytesHash',
]);

function exactKeys(value, keys) {
  return hasExactPlainObjectKeys(value, [...keys].sort());
}

function canonicalUtf8(value) {
  return typeof value === 'string'
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function canonicalRelativePath(value, { root = false } = {}) {
  if (!canonicalUtf8(value)) return false;
  if (root && value === '.') return true;
  if (!value || value === '.' || value.startsWith('/') || value.endsWith('/')
    || value.includes('\0') || value.includes('\\')) return false;
  const components = value.split('/');
  return components.every((component) => component
    && component !== '.' && component !== '..'
    && Buffer.byteLength(component, 'utf8') <= 255)
    && Buffer.byteLength(value, 'utf8') <= 4096;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function parentPath(value) {
  const boundary = value.lastIndexOf('/');
  return boundary < 0 ? '.' : value.slice(0, boundary);
}

function validOwnership(entry) {
  return Number.isSafeInteger(entry?.uid) && entry.uid >= 0
    && Number.isSafeInteger(entry?.gid) && entry.gid >= 0;
}

function validMode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0o777;
}

function validEntry(entry, index) {
  if (!entry || !canonicalRelativePath(entry.path, { root: index === 0 })) return false;
  if (!validMode(entry.posixMode) || !validOwnership(entry)) return false;
  if (entry.kind === 'directory') {
    return exactKeys(entry, DIRECTORY_ENTRY_KEYS)
      && (entry.posixMode & 0o500) === 0o500;
  }
  return entry.kind === 'file'
    && exactKeys(entry, FILE_ENTRY_KEYS)
    && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0
    && SHA256.test(String(entry.bytesHash || ''));
}

function canonicalEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 1) return false;
  if (entries[0]?.path !== '.' || entries[0]?.kind !== 'directory') return false;
  const paths = entries.map((entry) => entry?.path);
  if (new Set(paths).size !== paths.length) return false;
  if (JSON.stringify(paths.slice(1))
    !== JSON.stringify([...paths.slice(1)].sort(compareUtf8))) return false;
  if (!entries.every(validEntry)) return false;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return entries.slice(1).every((entry) => byPath.get(parentPath(entry.path))?.kind === 'directory');
}

function inventoryPayload(inventory = {}) {
  return Object.freeze({
    version: 1,
    kind: 'PackageRecoveryTreeInventory',
    entries: inventory.entries,
    fileCount: inventory.fileCount,
    directoryCount: inventory.directoryCount,
    totalBytes: inventory.totalBytes,
  });
}

export function packageRecoveryTreeInventoryHash(inventory = {}) {
  return hashRecord('PackageRecoveryTreeInventory', inventoryPayload(inventory));
}

export function verifyPackageRecoveryTreeInventory(inventory) {
  const blockers = [];
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
  const fileCount = entries.filter((entry) => entry?.kind === 'file').length;
  const directoryCount = entries.filter((entry) => entry?.kind === 'directory').length;
  const totalBytes = entries.reduce((total, entry) => (
    entry?.kind === 'file' && Number.isSafeInteger(entry.bytes)
      ? total + entry.bytes : total
  ), 0);
  if (!exactKeys(inventory, INVENTORY_KEYS)
    || inventory?.version !== 1
    || inventory.kind !== 'PackageRecoveryTreeInventory'
    || !canonicalEntries(entries)
    || inventory.fileCount !== fileCount
    || inventory.directoryCount !== directoryCount
    || !Number.isSafeInteger(totalBytes)
    || inventory.totalBytes !== totalBytes
    || inventory.packageRecoveryTreeInventoryHash
      !== packageRecoveryTreeInventoryHash(inventory)) {
    blockers.push('package_recovery_tree_inventory_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

export function createPackageRecoveryTreeInventory({ entries } = {}) {
  const frozenEntries = Object.freeze((Array.isArray(entries) ? entries : [])
    .map((entry) => Object.freeze({ ...entry })));
  const payload = inventoryPayload({
    entries: frozenEntries,
    fileCount: frozenEntries.filter((entry) => entry.kind === 'file').length,
    directoryCount: frozenEntries.filter((entry) => entry.kind === 'directory').length,
    totalBytes: frozenEntries.reduce((total, entry) => (
      entry.kind === 'file' ? total + entry.bytes : total
    ), 0),
  });
  const inventory = Object.freeze({
    ...payload,
    packageRecoveryTreeInventoryHash:
      hashRecord('PackageRecoveryTreeInventory', payload),
  });
  if (!verifyPackageRecoveryTreeInventory(inventory).valid) {
    throw new Error('package_recovery_tree_inventory_invalid');
  }
  return inventory;
}
