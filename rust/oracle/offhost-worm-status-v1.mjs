// Isolated differential oracle. Synthetic custodian keys and mount/immutable
// overrides exercise Node's real verifier; they confer no production authority.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyOffhostWormTarget } from '../../paper-adapters/archives/offhost-worm-target-verification.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  evaluateFullProductionReadiness,
  FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS,
} from '../../paper-application/automation/full-production-readiness-policy.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

function custodyEvidenceFixture({ contract, targetMountRoot, receiptType = 'object_lock' }) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyId = 'custody-key-1';
  const custodianId = 'independent-custodian-1';
  const role = 'offhost_worm_independent_custodian';
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId,
      subjectId: custodianId,
      organization: 'Independent Custody Fixture',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [role],
      status: 'active',
      effectiveFrom: '2026-08-08T00:00:00.000Z',
      expiresAt: '2026-08-10T00:00:00.000Z',
      revokedAt: null,
    }],
  };
  const trust = inspectPinnedExternalEvidenceTrustStore(trustStore, {
    requiredRole: role,
    expectedKeyIds: [keyId],
  });
  assert.equal(trust.ready, true);
  const storageIdentityHash = hashRecord('OffhostWormStorageIdentityFixture', {
    targetMountRoot,
  });
  const snapshotId = (receiptType === 'object_lock' ? 'a' : 'b').repeat(64);
  const snapshotRoot = path.join(targetMountRoot, 'hepta-paper-worm', snapshotId);
  const objectRoot = path.join(snapshotRoot, 'objects');
  fs.mkdirSync(objectRoot, { recursive: true });
  const objectBytes = Buffer.from('qualified custody snapshot object\n');
  const objectHash = hashBytes(objectBytes);
  const objectPath = path.join(objectRoot, objectHash.replace(/^sha256:/u, ''));
  fs.writeFileSync(objectPath, objectBytes, { mode: 0o444 });
  const objects = [{
    role: 'fixture',
    sourceHash: objectHash,
    objectPath,
    objectHash,
    immutable: true,
  }];
  const manifestPayload = {
    version: 2,
    kind: 'OffhostWormSnapshotManifest',
    contractId: contract.contractId,
    snapshotId,
    protectionLevel: 'same_host_external_disk',
    offHostOrOffsiteCustodyQualified: false,
    objects,
  };
  const snapshotManifest = {
    ...manifestPayload,
    manifestHash: hashRecord('OffhostWormSnapshotManifest', manifestPayload),
    signature: { fixture: true },
  };
  const custodySnapshotManifestPath = path.join(
    snapshotRoot,
    'OFFHOST_WORM_SNAPSHOT_MANIFEST.json',
  );
  fs.writeFileSync(
    custodySnapshotManifestPath,
    `${JSON.stringify(snapshotManifest, null, 2)}\n`,
    { mode: 0o444 },
  );
  const selectedContract = {
    ...contract,
    offHostOrOffsiteCustodyQualified: true,
    custodyEvidencePath: '/fixture/OFFHOST_WORM_CUSTODY_EVIDENCE.json',
    custodyTrustStorePath: '/fixture/OFFHOST_WORM_CUSTODY_TRUST_STORE.json',
    custodyTrustStoreHash: trust.trustStoreHash,
    custodySignerKeyIds: [keyId],
    custodyEvidenceMaximumLifetimeMs: 60 * 60 * 1000,
    custodySnapshotManifestPath,
  };
  const receiptPayload = {
    version: 1,
    kind: 'OffhostWormCustodyReceipt',
    contractId: contract.contractId,
    receiptType,
    targetMountRoot,
    storageIdentityHash,
    snapshotManifestHash: snapshotManifest.manifestHash,
    snapshotObjectSetHash: hashRecord('OffhostWormSnapshotObjectSet', objects),
    storageSubjectId: 'storage-provider-1',
    custodyClass: 'offsite',
    issuedAt: '2026-08-09T00:00:00.000Z',
    expiresAt: '2026-08-09T00:45:00.000Z',
  };
  const receipt = {
    ...receiptPayload,
    receiptHash: hashRecord('OffhostWormCustodyReceipt', receiptPayload),
  };
  const subjectPayload = {
    version: 1,
    kind: 'OffhostWormCustodyAttestationSubject',
    contractId: contract.contractId,
    targetMountRoot,
    custodyReceiptHash: receipt.receiptHash,
    custodyClass: 'offsite',
    independentCustodianId: custodianId,
    attestedAt: '2026-08-09T00:05:00.000Z',
    expiresAt: '2026-08-09T00:40:00.000Z',
  };
  const attestationSubject = {
    ...subjectPayload,
    offhostWormCustodyAttestationSubjectHash: hashRecord(
      'OffhostWormCustodyAttestationSubject',
      subjectPayload,
    ),
  };
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind: 'OffhostWormCustodyAttestationSubject',
    subjectHash: attestationSubject.offhostWormCustodyAttestationSubjectHash,
    signedAt: attestationSubject.attestedAt,
    expiresAt: attestationSubject.expiresAt,
    signatures: [{ keyId, role, algorithm: 'ed25519', value: 'placeholder' }],
  });
  const authorityEnvelope = buildPinnedExternalEvidenceEnvelope({
    ...placeholder,
    signatures: [{
      keyId,
      role,
      algorithm: 'ed25519',
      value: crypto.sign(
        null,
        pinnedExternalEvidenceSigningPayload(placeholder),
        pair.privateKey,
      ).toString('base64'),
    }],
  });
  const bundlePayload = {
    version: 1,
    kind: 'OffhostWormCustodyEvidenceBundle',
    receipt,
    attestationSubject,
    authorityEnvelope,
  };
  return Object.freeze({
    contract: selectedContract,
    storageIdentityHash,
    objectPath,
    trustStore,
    evidence: {
      ...bundlePayload,
      custodyEvidenceBundleHash: hashRecord(
        'OffhostWormCustodyEvidenceBundle',
        bundlePayload,
      ),
    },
  });
}

function aggregateReady(status, observedAt, contractId) {
  return evaluateFullProductionReadiness({
    automationReport: {},
    packageRetentionRecoveryInspection: { kind: 'PackageRetentionRecoveryReadinessInspection' },
    offhostWormCustodyInspection: status,
    independentExternalOwnerAcceptanceInspection: {
      version: 1, kind: 'IndependentExternalOwnerAcceptanceInspection',
      status: 'independent_external_owner_acceptance_blocked', required: 249,
      externallyAccepted: 0, localAdminAccepted: 0,
      familyManifestBound: false, automaticAcceptanceForbidden: true,
    },
    independentProductionOperationalProofInspection: {
      version: 1, kind: 'IndependentProductionOperationalProofInspection',
      status: 'independent_production_operational_proof_blocked',
      releaseCommit: 'a'.repeat(40), required: FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.length,
      verified: 0, externalIndependentRequired: true, conformanceCannotQualify: true,
      capabilities: FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.map(capabilityId => ({
        capabilityId, verified: false, operationalReceiptHashes: [], issuerAssurances: [],
      })),
    },
    offhostWormContractId: contractId, observedAt,
  }).offhostWormCustodyReady;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-rust-oracle-'));
try {
  const targetMountRoot = path.join(root, 'target');
  fs.mkdirSync(targetMountRoot);
  const contract = {
    version: 1, kind: 'OffhostWormSnapshotContract', contractId: 'rust-offhost-fixture',
    targetMountRoot, requireDistinctFilesystemDevice: true,
    offHostOrOffsiteCustodyQualified: false,
  };
  const now = new Date('2026-08-09T00:10:00.000Z');
  const probe = {
    workspaceRoot: root, contract, mountedStorageOverride: null,
    mountAvailableOverride: true, distinctDeviceOverride: true, now,
  };
  const fixture = custodyEvidenceFixture({ contract, targetMountRoot });
  const verifiedOptions = {
    ...probe, contract: fixture.contract, custodyEvidenceOverride: fixture.evidence,
    custodyTrustStoreOverride: fixture.trustStore,
    storageIdentityHashOverride: fixture.storageIdentityHash,
    custodyImmutableOverride: true, requireCustody: true,
  };
  const positive = verifyOffhostWormTarget(verifiedOptions);
  const cases = [
    { label: 'diagnostic-without-custody', status: verifyOffhostWormTarget(probe) },
    { label: 'required-missing-custody', status: verifyOffhostWormTarget({ ...probe, requireCustody: true }) },
    { label: 'verified-custody', status: positive },
    { label: 'expired-at-aggregation', status: positive, observedAt: '2026-08-09T00:40:00.000Z' },
    { label: 'wrong-contract-at-aggregation', status: positive, contractId: 'another-contract' },
    { label: 'expired-at-verifier', status: verifyOffhostWormTarget({ ...verifiedOptions, now: new Date('2026-08-09T00:45:00.000Z') }) },
    { label: 'replaced-storage', status: verifyOffhostWormTarget({ ...verifiedOptions, storageIdentityHashOverride: hashRecord('ReplacementStorage', {}) }) },
    { label: 'mount-unavailable', status: verifyOffhostWormTarget({ ...verifiedOptions, mountAvailableOverride: false }) },
  ];
  fs.chmodSync(fixture.objectPath, 0o644);
  fs.writeFileSync(fixture.objectPath, 'changed after attestation\n');
  fs.chmodSync(fixture.objectPath, 0o444);
  cases.push({ label: 'changed-snapshot-object', status: verifyOffhostWormTarget(verifiedOptions) });
  const results = cases.map(({ label, status, observedAt = now.toISOString(), contractId = contract.contractId }) => ({
    label, status, observedAt, contractId, ready: aggregateReady(status, observedAt, contractId),
  }));
  process.stdout.write(JSON.stringify({ profile: { node: process.version }, results }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
