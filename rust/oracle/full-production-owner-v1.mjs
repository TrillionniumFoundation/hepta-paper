// Differential oracle for the owner axis of full-production-readiness.
// It imports the incumbent Node authority verifier and performs no writes.
import fs from 'node:fs';
import {
  LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT,
  LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST,
} from '../../paper-adapters/governance/legacy-owner-acceptance-contract.mjs';
import {
  verifyOwnerAcceptanceDocument,
} from '../../paper-adapters/governance/owner-acceptance-verifier.mjs';

const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const { document, trustStore, trust, familyManifest = LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST } = request;
const selectedTrustStore = trustStore ?? trust;
const required = LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT;
const expectedFamilyIds = familyManifest.families.map((family) => family.familyId).sort();
const actualFamilyIds = Array.isArray(document?.acceptedFamilies)
  ? document.acceptedFamilies.map((family) => String(family?.familyId || '')).sort()
  : [];
const familyManifestBound = document?.version === 2
  && document.kind === 'CapabilityOwnerAcceptance'
  && document.familyManifestHash === familyManifest.familyManifestHash
  && actualFamilyIds.length === expectedFamilyIds.length
  && new Set(actualFamilyIds).size === actualFamilyIds.length
  && JSON.stringify(actualFamilyIds) === JSON.stringify(expectedFamilyIds);
const accepted = familyManifestBound
  ? verifyOwnerAcceptanceDocument({
    document,
    trustStore: selectedTrustStore,
    familyManifest,
  }) : new Map();
const records = accepted instanceof Map ? [...accepted.values()] : [];
const externallyAccepted = records.filter((record) => (
  record?.issuerAssurance === 'external_independent'
    && record?.acceptanceClass === 'external_independent_owner_acceptance'
)).length;
const localAdminAccepted = records.filter((record) => (
  record?.issuerAssurance === 'local_admin_delegated'
    && record?.acceptanceClass === 'local_admin_delegated_owner_acceptance'
)).length;
process.stdout.write(JSON.stringify({
  version: 1,
  kind: 'IndependentExternalOwnerAcceptanceInspection',
  status: familyManifestBound && externallyAccepted === required
    ? 'independent_external_owner_acceptance_ready'
    : 'independent_external_owner_acceptance_blocked',
  externallyAccepted,
  required,
  familyManifestBound,
  familyManifestHash: document?.familyManifestHash || null,
  localAdminAccepted,
  automaticAcceptanceForbidden: true,
}));
