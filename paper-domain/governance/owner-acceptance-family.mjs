import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function safeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function familyKey(entry) {
  if (!entry.capabilityIds?.length) {
    const retirementDisposition = entry.migrationAction || entry.priorDisposition;
    if (!retirementDisposition) {
      throw new Error(`owner acceptance retirement disposition missing:${entry.id || 'unknown'}`);
    }
    return `retirement:${retirementDisposition}`;
  }
  return `${entry.businessDecision}:${[...entry.capabilityIds].sort().join('+')}`;
}

export function buildOwnerAcceptanceFamilies(entryPlans = []) {
  const grouped = new Map();
  for (const entry of entryPlans) {
    const key = familyKey(entry);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  const families = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entries]) => {
      const ordered = [...entries].sort((left, right) => left.id.localeCompare(right.id));
      const payload = {
        version: 1,
        kind: 'CapabilityOwnerAcceptanceFamily',
        familyId: `family:${safeId(key)}`,
        businessDecision: ordered[0].businessDecision,
        migrationAction: ordered[0].migrationAction || ordered[0].priorDisposition || null,
        capabilityIds: [...new Set(ordered.flatMap((entry) => entry.capabilityIds || []))].sort(),
        legacyEntries: ordered.map((entry) => ({
          legacyMatrixEntryId: entry.id,
          sourceSha256: entry.source.sha256,
        })),
      };
      return Object.freeze({
        ...payload,
        familyHash: hashRecord('CapabilityOwnerAcceptanceFamily', payload),
      });
    });
  const manifestPayload = {
    version: 1,
    kind: 'CapabilityOwnerAcceptanceFamilyManifest',
    families: families.map((family) => ({ familyId: family.familyId, familyHash: family.familyHash })),
  };
  return Object.freeze({
    ...manifestPayload,
    familyManifestHash: hashRecord('CapabilityOwnerAcceptanceFamilyManifest', manifestPayload),
    families,
  });
}
