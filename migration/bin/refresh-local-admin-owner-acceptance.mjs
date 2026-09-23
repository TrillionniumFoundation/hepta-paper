#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLegacyCapabilityMatrixV3 } from '../legacy-capability-matrix-v3.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

if (!process.argv.includes('--execute')) throw new Error('local admin owner acceptance refresh requires --execute');
const runtimeRoot = defaultPaperRuntimeRoot();
const ownerRoot = path.join(runtimeRoot, 'owner-acceptance');
const trustStorePath = path.join(ownerRoot, 'OWNER_TRUST_STORE.json');
const privateKeyPath = process.env.HEPTA_CAPABILITY_OWNER_PRIVATE_KEY
  || path.join(os.homedir(), '.local', 'share', 'hepta-paper', 'capability-owner', 'capability-owner-ed25519-private.pem');
if (!fs.existsSync(privateKeyPath)) throw new Error('local admin delegated owner key missing outside repository');
const privateMode = fs.statSync(privateKeyPath).mode & 0o777;
if (privateMode !== 0o600) throw new Error(`local admin delegated owner key mode invalid:${privateMode.toString(8)}`);
const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
function writePublicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o444 });
  fs.renameSync(temporary, file);
}
const trustStore = JSON.parse(fs.readFileSync(trustStorePath, 'utf8'));
const ownerKey = (trustStore.keys || []).find((key) => key.status === 'active' && key.roles?.includes('capability_owner'));
if (!ownerKey) throw new Error('active capability owner key missing');
const derivedPublic = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
if (String(derivedPublic).trim() !== String(ownerKey.publicKeyPem).trim()) throw new Error('local admin owner private/public key mismatch');

const classifiedTrustStore = {
  ...trustStore,
  keys: trustStore.keys.map((key) => key.keyId === ownerKey.keyId ? {
    ...key,
    assurance: 'local_admin_delegated',
    independentExternalAuthority: false,
    permittedEvidenceClasses: ['local_admin_owner_acceptance', 'production_source_bound_conformance'],
  } : key),
};
writePublicJson(trustStorePath, classifiedTrustStore);

const matrix = buildLegacyCapabilityMatrixV3({ runtimeRoot });
const acceptedAt = new Date().toISOString();
let acceptance = {
  version: 2,
  kind: 'CapabilityOwnerAcceptance',
  authorizationMode: 'explicit_owner_delegation_to_local_signing_agent',
  assurance: 'local_admin_delegated',
  independentExternalAuthority: false,
  familyManifestHash: matrix.ownerAcceptanceFamilyManifest.familyManifestHash,
  acceptedAt,
  acceptedFamilies: matrix.ownerAcceptanceFamilyManifest.families.map((family) => ({
    familyId: family.familyId,
    familyHash: family.familyHash,
    businessDecision: family.businessDecision,
  })),
  signatures: [],
};
acceptance = signAuthorityDocument(acceptance, { privateKeyPem, keyId: ownerKey.keyId, role: 'capability_owner' });
writePublicJson(path.join(ownerRoot, 'CAPABILITY_OWNER_ACCEPTANCE.json'), acceptance);

const delegationPayload = {
  version: 2,
  kind: 'CapabilityOwnerSigningDelegationReceipt',
  status: 'local_admin_delegated_signing_key_active',
  subjectId: ownerKey.subjectId,
  keyId: ownerKey.keyId,
  proofClass: 'key_possession_and_local_admin_delegation_record',
  assurance: 'local_admin_delegated',
  independentExternalDelegationVerified: false,
  privateKeyPathOutsideRepository: true,
  privateKeyMode: '0600',
  acceptedFamilyManifestHash: matrix.ownerAcceptanceFamilyManifest.familyManifestHash,
  acceptedFamilyCount: matrix.ownerAcceptanceFamilyManifest.families.length,
  acceptedEntryCount: matrix.entries.length,
  createdAt: acceptedAt,
  authorizationScope: ['local_admin_capability_owner_acceptance', 'production_source_bound_conformance_receipts'],
  excludedAuthorizationScope: ['independent_external_owner_attestation', 'production_runtime_operational_observation'],
  externalActionPerformed: false,
};
let delegation = {
  ...delegationPayload,
  delegationReceiptHash: hashRecord('CapabilityOwnerSigningDelegationReceipt', delegationPayload),
  signatures: [],
};
delegation = signAuthorityDocument(delegation, { privateKeyPem, keyId: ownerKey.keyId, role: 'capability_owner' });
writePublicJson(path.join(ownerRoot, 'OWNER_SIGNING_DELEGATION_RECEIPT.json'), delegation);

const refreshed = buildLegacyCapabilityMatrixV3({ runtimeRoot });
if (refreshed.summary.ownerAccepted !== refreshed.summary.entryCount) throw new Error('local admin owner acceptance refresh incomplete');
process.stdout.write(`${JSON.stringify({
  status: 'local_admin_owner_acceptance_refreshed',
  assurance: 'local_admin_delegated',
  independentExternalAuthority: false,
  familyCount: refreshed.summary.ownerAcceptanceFamilyCount,
  ownerAccepted: refreshed.summary.ownerAccepted,
  externallyOwnerAccepted: refreshed.summary.externallyOwnerAccepted,
  localAdminOwnerAccepted: refreshed.summary.localAdminOwnerAccepted,
  familyManifestHash: refreshed.ownerAcceptanceFamilyManifest.familyManifestHash,
}, null, 2)}\n`);
