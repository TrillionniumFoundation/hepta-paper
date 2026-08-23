import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin, sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import { retentionMemberHash } from './runtime-retention-scope-repository.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from './package-recovery-tree-inventory-repository.mjs';
import {
  assertSealedImmutableCampaignPackageFilesSync,
} from './campaign-release-materialization.mjs';

function pinnedDirectoryIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('package_lifecycle_package_directory_invalid');
  }
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    realPath: fs.realpathSync.native(candidate),
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.realPath === right.realPath;
}

function readManifest(candidate) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('package_lifecycle_cas_manifest_invalid');
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch {
    throw new Error('package_lifecycle_cas_manifest_invalid');
  }
  return Object.freeze({
    name: path.basename(candidate),
    fileHash: sha256FileSync(candidate),
    logicalPath: typeof value?.logicalPath === 'string' ? value.logicalPath : null,
    contentHash: typeof value?.contentHash === 'string' ? value.contentHash : null,
    manifestHash: typeof value?.manifestHash === 'string' ? value.manifestHash : null,
  });
}

export function createPackageLifecycleMaterializationInspector({ runtimeRoot } = {}) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim()) {
    throw new Error('package_lifecycle_runtime_root_missing');
  }
  const root = path.resolve(runtimeRoot);

  function existingRuntimeRoot() {
    if (!fs.existsSync(root)) throw new Error('package_lifecycle_runtime_root_missing');
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('package_lifecycle_runtime_root_invalid');
    }
    return fs.realpathSync.native(root);
  }

  function inspectRelease({ releaseBundle } = {}) {
    const rootReal = existingRuntimeRoot();
    const packageOutput = releaseBundle?.packageOutput;
    const packagePath = path.resolve(String(packageOutput?.packageDir || ''));
    if (packageOutput?.immutable !== true
      || releaseBundle?.immutableCampaignPackageOutputHash
        !== packageOutput?.immutableCampaignPackageOutputHash
      || !/^sha256:[a-f0-9]{64}$/.test(
        String(packageOutput?.immutableCampaignPackageOutputHash || ''),
      )
      || packagePath === root
      || !pathWithin(rootReal, fs.realpathSync.native(packagePath))) {
      throw new Error('package_lifecycle_release_package_binding_invalid');
    }
    const before = pinnedDirectoryIdentity(packagePath);
    assertSealedImmutableCampaignPackageFilesSync(packageOutput, root);
    const firstInventory = inspectPackageRecoveryTreeInventorySync({ packagePath });
    const firstHash = retentionMemberHash(packagePath);
    const secondInventory = inspectPackageRecoveryTreeInventorySync({ packagePath });
    const secondHash = retentionMemberHash(packagePath);
    assertSealedImmutableCampaignPackageFilesSync(packageOutput, root);
    const after = pinnedDirectoryIdentity(packagePath);
    if (!sameIdentity(before, after) || firstHash !== secondHash
      || firstInventory.inventory.packageRecoveryTreeInventoryHash
        !== secondInventory.inventory.packageRecoveryTreeInventoryHash) {
      throw new Error('package_lifecycle_package_changed_during_inspection');
    }
    return Object.freeze({
      packagePath,
      packageContentHash: firstHash,
      packageRecoveryTreeInventoryHash:
        firstInventory.inventory.packageRecoveryTreeInventoryHash,
      immutableCampaignPackageOutputHash:
        packageOutput.immutableCampaignPackageOutputHash,
      packageDirectoryIdentity: before,
    });
  }

  function casReferenceAuthority({ packagePath, packageContentHash } = {}) {
    existingRuntimeRoot();
    const manifestRoot = path.join(root, 'artifact-cas', 'manifests');
    const rows = fs.existsSync(manifestRoot)
      ? fs.readdirSync(manifestRoot).sort()
        .map((name) => readManifest(path.join(manifestRoot, name)))
      : [];
    const packageResolved = path.resolve(packagePath);
    const references = rows.filter((row) => row.contentHash === packageContentHash
      || (row.logicalPath
        && path.resolve(root, row.logicalPath) === packageResolved));
    return Object.freeze({
      inventoryHash: hashRecord('PackageLifecycleCasManifestInventory', rows),
      referenceManifestHashes: Object.freeze(references
        .map((row) => row.manifestHash || row.fileHash).sort()),
    });
  }

  return Object.freeze({
    version: 1,
    kind: 'PackageLifecycleMaterializationInspector',
    inspectRelease,
    casReferenceAuthority,
  });
}
