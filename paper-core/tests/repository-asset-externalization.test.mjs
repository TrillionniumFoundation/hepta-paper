import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { inspectRepositoryAssetExternalization } from '../src/repository-asset-externalization.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'paper-core',
  'config',
  'repository-asset-externalization.v1.json',
), 'utf8'));

test('large repository assets remain integrity-bound until external references verify', () => {
  const inspection = inspectRepositoryAssetExternalization({ repositoryRoot, manifest });
  assert.equal(inspection.status, 'repository_asset_boundary_ready_externalization_pending');
  assert.equal(inspection.repositoryBoundaryReady, true);
  assert.equal(inspection.fullyExternalized, false);
  assert.deepEqual(inspection.integrityBlockers, []);
  assert.deepEqual(inspection.externalizationBlockers, [
    'r-scientific-source-cas:external_registry_reference_required',
    'design-production-core-reference:read_only_reference_release_required',
  ]);
});

test('asset identity drift and incomplete externalization fail closed', () => {
  const identityDrift = structuredClone(manifest);
  identityDrift.assets[0].expectedIdentitySha256 = `sha256:${'0'.repeat(64)}`;
  const driftInspection = inspectRepositoryAssetExternalization({
    repositoryRoot,
    manifest: identityDrift,
  });
  assert.equal(driftInspection.repositoryBoundaryReady, false);
  assert.ok(driftInspection.integrityBlockers.includes(
    'r-scientific-source-cas:repository_asset_identity_hash_mismatch',
  ));

  const incomplete = structuredClone(manifest);
  incomplete.assets[0].migrationStatus = 'externalized';
  const incompleteInspection = inspectRepositoryAssetExternalization({
    repositoryRoot,
    manifest: incomplete,
  });
  assert.ok(incompleteInspection.integrityBlockers.includes(
    'r-scientific-source-cas:repository_asset_external_reference_incomplete',
  ));
});

test('externalization requires a content-bound restore-drill receipt', () => {
  const externalized = structuredClone(manifest);
  const asset = externalized.assets[0];
  const digest = `sha256:${'a'.repeat(64)}`;
  const receiptPayload = {
    version: 1,
    kind: 'RepositoryAssetExternalRestoreDrillReceipt',
    status: 'repository_asset_external_restore_verified',
    assetId: asset.assetId,
    externalReferenceDigest: digest,
    restoredIdentitySha256: asset.expectedIdentitySha256,
    verifiedAt: '2026-07-26T12:00:00.000Z',
  };
  asset.migrationStatus = 'externalized';
  asset.externalReference = {
    kind: asset.requiredExternalReferenceKind,
    location: `oci://registry.example/hepta/r-scientific@${digest}`,
    digest,
    restoreDrillReceipt: {
      ...receiptPayload,
      repositoryAssetExternalRestoreDrillReceiptHash: hashRecord(
        'RepositoryAssetExternalRestoreDrillReceipt',
        receiptPayload,
      ),
    },
  };
  const ready = inspectRepositoryAssetExternalization({ repositoryRoot, manifest: externalized });
  assert.equal(ready.assets[0].externalized, true);
  assert.deepEqual(ready.assets[0].blockers, []);

  asset.externalReference.restoreDrillReceipt.restoredIdentitySha256 =
    `sha256:${'b'.repeat(64)}`;
  const tampered = inspectRepositoryAssetExternalization({
    repositoryRoot,
    manifest: externalized,
  });
  assert.ok(tampered.integrityBlockers.includes(
    'r-scientific-source-cas:repository_asset_external_reference_incomplete',
  ));
});
