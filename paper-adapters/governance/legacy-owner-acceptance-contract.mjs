import fs from 'node:fs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const manifestUrl = new URL(
  '../../paper-domain/governance/legacy-owner-acceptance-family-manifest.v1.json',
  import.meta.url,
);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));
  if (manifest?.version !== 1 || manifest?.kind !== 'CapabilityOwnerAcceptanceFamilyManifest'
    || !Array.isArray(manifest.families) || !manifest.families.length) {
    throw new Error('legacy_owner_acceptance_family_manifest_invalid');
  }
  const familyIds = new Set();
  const entryIds = new Set();
  for (const family of manifest.families) {
    const { familyHash, ...payload } = family || {};
    if (!familyHash || hashRecord('CapabilityOwnerAcceptanceFamily', payload) !== familyHash) {
      throw new Error(`legacy_owner_acceptance_family_hash_invalid:${family?.familyId || 'unknown'}`);
    }
    if (!family.familyId || familyIds.has(family.familyId)) {
      throw new Error(`legacy_owner_acceptance_family_id_invalid:${family?.familyId || 'unknown'}`);
    }
    familyIds.add(family.familyId);
    for (const entry of family.legacyEntries || []) {
      if (!entry?.legacyMatrixEntryId || entryIds.has(entry.legacyMatrixEntryId)) {
        throw new Error(`legacy_owner_acceptance_entry_id_invalid:${entry?.legacyMatrixEntryId || 'unknown'}`);
      }
      entryIds.add(entry.legacyMatrixEntryId);
    }
  }
  const manifestPayload = {
    version: manifest.version,
    kind: manifest.kind,
    families: manifest.families.map((family) => ({
      familyId: family.familyId,
      familyHash: family.familyHash,
    })),
  };
  if (hashRecord('CapabilityOwnerAcceptanceFamilyManifest', manifestPayload)
    !== manifest.familyManifestHash) {
    throw new Error('legacy_owner_acceptance_family_manifest_hash_invalid');
  }
  return { manifest: deepFreeze(manifest), entryCount: entryIds.size };
}

const loaded = loadManifest();

export const LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST = loaded.manifest;
export const LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT = loaded.entryCount;
