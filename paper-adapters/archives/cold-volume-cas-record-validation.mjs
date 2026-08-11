import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readPinnedCasJsonRecord } from './cold-volume-cas-path-boundary.mjs';

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

export function isColdVolumeCasCurrentPointer(pointer) {
  return exactKeys(pointer, CURRENT_POINTER_KEYS)
    && pointer.version === 1
    && pointer.kind === 'ColdVolumeCasCurrentManifest'
    && SHA256.test(String(pointer.manifestHash || ''));
}

export function expectedColdVolumeCasContractBinding({
  contract,
  contractPath = null,
  contractHash = null,
} = {}) {
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

export function validateColdVolumeCasManifest({ manifest, manifestPath, binding }) {
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
