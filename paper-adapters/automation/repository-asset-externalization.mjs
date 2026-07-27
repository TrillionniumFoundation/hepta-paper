import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectRepositoryAssetSubmoduleBinding,
} from './repository-asset-submodule-binding.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MIGRATION_BLOCKERS = Object.freeze({
  'pending-external-registry-reference': 'external_registry_reference_required',
  'pending-read-only-reference-release': 'read_only_reference_release_required',
});

function repositoryRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('repository_asset_path_invalid');
  }
  return normalized;
}

function externalRestoreDrillReceiptValid(asset, receipt) {
  const {
    repositoryAssetExternalRestoreDrillReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  return receipt?.version === 1
    && receipt?.kind === 'RepositoryAssetExternalRestoreDrillReceipt'
    && receipt?.status === 'repository_asset_external_restore_verified'
    && receipt?.assetId === asset.assetId
    && receipt?.externalReferenceDigest === asset.externalReference?.digest
    && receipt?.restoredIdentitySha256 === asset.expectedIdentitySha256
    && Number.isFinite(Date.parse(String(receipt?.verifiedAt || '')))
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('RepositoryAssetExternalRestoreDrillReceipt', payload) === claimedHash;
}

function inspectAsset(repositoryRoot, asset) {
  const blockers = [];
  let sourcePath = null;
  let identityFile = null;
  try {
    sourcePath = repositoryRelativePath(asset?.sourcePath);
    identityFile = repositoryRelativePath(asset?.identityFile);
  } catch (error) {
    blockers.push(String(error?.message || error));
  }
  if (!String(asset?.assetId || '').trim()) blockers.push('repository_asset_id_required');
  if (!SHA256.test(String(asset?.expectedIdentitySha256 || ''))) {
    blockers.push('repository_asset_identity_hash_invalid');
  }
  if (!String(asset?.currentStorage || '').trim()
    || !String(asset?.targetStorage || '').trim()
    || !String(asset?.requiredExternalReferenceKind || '').trim()
    || !String(asset?.retentionPolicy || '').trim()) {
    blockers.push('repository_asset_storage_policy_incomplete');
  }
  const migrationBlocker = MIGRATION_BLOCKERS[asset?.migrationStatus] || null;
  if (!migrationBlocker && asset?.migrationStatus !== 'externalized') {
    blockers.push('repository_asset_migration_status_invalid');
  }
  let observedIdentitySha256 = null;
  if (sourcePath && identityFile) {
    const sourceRoot = path.resolve(repositoryRoot, sourcePath);
    const identityPath = path.resolve(repositoryRoot, identityFile);
    const contained = identityPath === sourceRoot
      || identityPath.startsWith(`${sourceRoot}${path.sep}`);
    if (!contained) blockers.push('repository_asset_identity_outside_source');
    else {
      try {
        const sourceStat = fs.lstatSync(sourceRoot);
        const identityStat = fs.lstatSync(identityPath);
        if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
          blockers.push('repository_asset_source_not_regular_directory');
        }
        if (identityStat.isSymbolicLink() || !identityStat.isFile()) {
          blockers.push('repository_asset_identity_not_regular_file');
        } else {
          observedIdentitySha256 = hashBytes(fs.readFileSync(identityPath));
          if (observedIdentitySha256 !== asset.expectedIdentitySha256) {
            blockers.push('repository_asset_identity_hash_mismatch');
          }
        }
      } catch {
        blockers.push('repository_asset_identity_unreadable');
      }
    }
  }
  if (asset?.migrationStatus === 'externalized') {
    const externalReference = asset?.externalReference;
    if (externalReference?.kind !== asset.requiredExternalReferenceKind
      || typeof externalReference?.location !== 'string'
      || !externalReference.location.trim()
      || externalReference.location.length > 2_048
      || /\s/.test(externalReference.location)
      || !SHA256.test(String(externalReference?.digest || ''))
      || !externalRestoreDrillReceiptValid(asset, externalReference?.restoreDrillReceipt)) {
      blockers.push('repository_asset_external_reference_incomplete');
    }
    if (sourcePath) blockers.push(
      ...inspectRepositoryAssetSubmoduleBinding(repositoryRoot, sourcePath, asset),
    );
  }
  return Object.freeze({
    assetId: asset?.assetId || null,
    sourcePath,
    identityFile,
    expectedIdentitySha256: asset?.expectedIdentitySha256 || null,
    observedIdentitySha256,
    currentStorage: asset?.currentStorage || null,
    targetStorage: asset?.targetStorage || null,
    migrationStatus: asset?.migrationStatus || null,
    integrityReady: blockers.length === 0,
    externalized: asset?.migrationStatus === 'externalized' && blockers.length === 0,
    blockers: Object.freeze(blockers),
    externalizationBlockers: Object.freeze(migrationBlocker ? [migrationBlocker] : []),
  });
}

export function inspectRepositoryAssetExternalization({
  repositoryRoot,
  manifest,
} = {}) {
  const manifestBlockers = [];
  if (manifest?.version !== 1
    || manifest?.kind !== 'RepositoryAssetExternalizationManifest'
    || !Array.isArray(manifest?.assets)
    || manifest.assets.length === 0) {
    manifestBlockers.push('repository_asset_externalization_manifest_invalid');
  }
  const assets = Object.freeze((manifest?.assets || []).map((asset) => (
    inspectAsset(path.resolve(repositoryRoot || process.cwd()), asset)
  )));
  if (assets.length !== new Set(assets.map((asset) => asset.assetId)).size) {
    manifestBlockers.push('repository_asset_id_duplicate');
  }
  const integrityBlockers = Object.freeze([
    ...manifestBlockers,
    ...assets.flatMap((asset) => asset.blockers.map((blocker) => (
      `${asset.assetId || 'unknown'}:${blocker}`
    ))),
  ]);
  const externalizationBlockers = Object.freeze(assets.flatMap((asset) => (
    asset.externalizationBlockers.map((blocker) => `${asset.assetId}:${blocker}`)
  )));
  return Object.freeze({
    version: 1,
    kind: 'RepositoryAssetExternalizationInspection',
    status: integrityBlockers.length
      ? 'repository_asset_boundary_blocked'
      : externalizationBlockers.length
        ? 'repository_asset_boundary_ready_externalization_pending'
        : 'repository_assets_externalized',
    repositoryBoundaryReady: integrityBlockers.length === 0,
    fullyExternalized:
      integrityBlockers.length === 0 && externalizationBlockers.length === 0,
    assets,
    integrityBlockers,
    externalizationBlockers,
  });
}

export function buildRepositoryAssetExternalizationHandoff({
  repositoryRoot,
  manifest,
} = {}) {
  const inspection = inspectRepositoryAssetExternalization({ repositoryRoot, manifest });
  if (!inspection.repositoryBoundaryReady) {
    throw new Error(
      `repository_asset_externalization_handoff_blocked:${inspection.integrityBlockers.join(',')}`,
    );
  }
  return Object.freeze({
    version: 1,
    kind: 'RepositoryAssetExternalizationHandoff',
    status: inspection.fullyExternalized
      ? 'repository_assets_already_externalized'
      : 'repository_asset_externalization_authority_required',
    assets: Object.freeze((manifest.assets || []).map((asset) => Object.freeze({
      assetId: asset.assetId,
      sourcePath: asset.sourcePath,
      identityFile: asset.identityFile,
      expectedIdentitySha256: asset.expectedIdentitySha256,
      targetStorage: asset.targetStorage,
      requiredExternalReferenceKind: asset.requiredExternalReferenceKind,
      retentionPolicy: asset.retentionPolicy,
      externalizationSequence: Object.freeze([
        'publish-immutable-reference',
        'verify-reference-digest',
        'restore-into-fresh-trusted-root',
        'verify-restored-identity',
        'issue-content-bound-restore-drill-receipt',
        'update-manifest-to-externalized',
        'switch-production-readers',
        'delete-tracked-payload-in-dedicated-migration',
      ]),
      requiredExternalReference: Object.freeze({
        kind: asset.requiredExternalReferenceKind,
        location: null,
        digest: null,
        restoreDrillReceipt: Object.freeze({
          version: 1,
          kind: 'RepositoryAssetExternalRestoreDrillReceipt',
          status: 'repository_asset_external_restore_verified',
          assetId: asset.assetId,
          externalReferenceDigest: null,
          restoredIdentitySha256: asset.expectedIdentitySha256,
          verifiedAt: null,
          repositoryAssetExternalRestoreDrillReceiptHash: null,
        }),
      }),
    }))),
    currentInspection: inspection,
  });
}
