import fs from 'node:fs';
import path from 'node:path';
import { verifyAuthoritySignatures } from '../paper-core/src/authority-signatures.mjs';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';

function safeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function familyKey(entry) {
  if (!entry.capabilityIds?.length) return `retirement:${entry.priorDisposition}`;
  return `${entry.businessDecision}:${[...entry.capabilityIds].sort().join('+')}`;
}

export function buildOwnerAcceptanceFamilies(entryPlans = []) {
  const grouped = new Map();
  for (const entry of entryPlans) {
    const key = familyKey(entry);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  const families = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, entries]) => {
    const ordered = [...entries].sort((left, right) => left.id.localeCompare(right.id));
    const payload = {
      version: 1,
      kind: 'CapabilityOwnerAcceptanceFamily',
      familyId: `family:${safeId(key)}`,
      businessDecision: ordered[0].businessDecision,
      capabilityIds: [...new Set(ordered.flatMap((entry) => entry.capabilityIds || []))].sort(),
      legacyEntries: ordered.map((entry) => ({
        legacyMatrixEntryId: entry.id,
        sourceSha256: entry.source.sha256,
      })),
    };
    return Object.freeze({ ...payload, familyHash: hashRecord('CapabilityOwnerAcceptanceFamily', payload) });
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

export function verifyOwnerAcceptanceDocument({ document, trustStore, familyManifest } = {}) {
  const accepted = new Map();
  if (document?.kind !== 'CapabilityOwnerAcceptance' || ![1, 2].includes(document?.version)) return accepted;
  const verification = verifyAuthoritySignatures({
    document,
    trustStore,
    requiredRoles: ['capability_owner'],
    minSignatures: 1,
  });
  if (!verification.cryptographicSignaturesVerified) return accepted;
  const evidenceHash = hashRecord('CapabilityOwnerAcceptance', document);
  const subjectId = verification.verifiedSubjectIds[0] || null;
  if (document.version === 2) {
    if (document.familyManifestHash !== familyManifest?.familyManifestHash) return accepted;
    const acceptedFamilies = new Map((document.acceptedFamilies || []).map((item) => [item.familyId, item]));
    for (const family of familyManifest.families || []) {
      const acceptance = acceptedFamilies.get(family.familyId);
      if (!acceptance || acceptance.familyHash !== family.familyHash || acceptance.businessDecision !== family.businessDecision) continue;
      for (const entry of family.legacyEntries) accepted.set(entry.legacyMatrixEntryId, {
        ...entry,
        businessDecision: family.businessDecision,
        familyId: family.familyId,
        familyHash: family.familyHash,
        acceptedAt: acceptance.acceptedAt || document.acceptedAt || null,
        evidenceHash,
        subjectId,
      });
    }
    return accepted;
  }
  for (const entry of document.acceptedEntries || []) accepted.set(entry.legacyMatrixEntryId, {
    ...entry,
    evidenceHash,
    subjectId,
  });
  return accepted;
}

export function loadOwnerAcceptance({ runtimeRoot, familyManifest } = {}) {
  if (!runtimeRoot) return new Map();
  try {
    const document = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'owner-acceptance', 'CAPABILITY_OWNER_ACCEPTANCE.json'), 'utf8'));
    const trustStore = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'owner-acceptance', 'OWNER_TRUST_STORE.json'), 'utf8'));
    return verifyOwnerAcceptanceDocument({ document, trustStore, familyManifest });
  } catch {
    return new Map();
  }
}
