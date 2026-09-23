import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyColdVolumeContract } from '../../paper-adapters/archives/cold-volume-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const WORKSPACE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function deviceMajorMinor(candidate) {
  const value = fs.lstatSync(candidate, { bigint: true }).dev;
  const major = ((value & 0x00000000000fff00n) >> 8n)
    | ((value & 0xfffff00000000000n) >> 32n);
  const minor = (value & 0x00000000000000ffn)
    | ((value & 0x00000ffffff00000n) >> 12n);
  return `${major}:${minor}`;
}

function directoryMountId(candidate) {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    const match = fs.readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8')
      .match(/^mnt_id:\s*([0-9]+)$/mu);
    assert.ok(match);
    return match[1];
  } finally {
    fs.closeSync(descriptor);
  }
}

test('cold-volume contract verifies logical links and fails closed until mounted content is manifested', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-volume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const mountRoot = path.join(root, 'mount');
  const logicalRoot = path.join(assetRoot, 'drafts', 'NDU_Nature_work');
  fs.mkdirSync(logicalRoot, { recursive: true });
  const contract = {
    version: 1,
    kind: 'ColdVolumeMountContract',
    contractId: 'fixture-v1',
    mountRoot,
    contentRoot: 'cold/NDU_Nature_work',
    sentinelRelativePath: 'cold/HEPTA_COLD_VOLUME_MANIFEST.json',
    contentManifestRequiredWhenMounted: true,
    entries: ['derivatives'],
  };
  fs.symlinkSync(path.join(mountRoot, contract.contentRoot, 'derivatives'), path.join(logicalRoot, 'derivatives'));
  const unavailable = verifyColdVolumeContract({ assetRoot, contract, mountAvailableOverride: false });
  assert.equal(unavailable.contractValid, true);
  assert.equal(unavailable.operationalReplayReady, false);
  fs.mkdirSync(path.join(mountRoot, contract.contentRoot, 'derivatives'), { recursive: true });
  const sentinelPayload = {
    version: 1,
    kind: 'ColdVolumeContentManifest',
    contractId: contract.contractId,
    entries: ['derivatives'],
  };
  const sentinel = { ...sentinelPayload, manifestHash: hashRecord('ColdVolumeContentManifest', sentinelPayload) };
  const sentinelPath = path.join(mountRoot, contract.sentinelRelativePath);
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, `${JSON.stringify(sentinel)}\n`);
  const ready = verifyColdVolumeContract({ assetRoot, contract, mountAvailableOverride: true });
  assert.equal(ready.status, 'cold_volume_mounted_and_content_verified');
  assert.equal(ready.operationalReplayReady, true);
});

test('cold-volume contract binds mounted storage identity and rejects mount mismatch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-volume-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const mountRoot = path.join(root, 'mount');
  const logicalRoot = path.join(assetRoot, 'drafts', 'NDU_Nature_work');
  const contentRoot = path.join(mountRoot, 'cold', 'NDU_Nature_work');
  fs.mkdirSync(logicalRoot, { recursive: true });
  fs.mkdirSync(path.join(contentRoot, 'derivatives'), { recursive: true });
  fs.symlinkSync(
    path.join(contentRoot, 'derivatives'),
    path.join(logicalRoot, 'derivatives'),
  );
  const expectedStorageIdentity = {
    filesystemType: 'ext4',
    filesystemUuid: '39324240-9c85-4d8a-a1b2-711f26c4ff77',
    partitionUuid: '7cb85044-3be4-4756-9c7e-bfd6be3eb49f',
  };
  const contract = {
    version: 1,
    kind: 'ColdVolumeMountContract',
    contractId: 'fixture-identity-v1',
    mountRoot,
    contentRoot: 'cold/NDU_Nature_work',
    sentinelRelativePath: 'cold/HEPTA_COLD_VOLUME_MANIFEST.json',
    contentManifestRequiredWhenMounted: true,
    expectedStorageIdentity,
    entries: ['derivatives'],
  };
  const writeSentinel = (entries) => {
    const payload = {
      version: 1,
      kind: 'ColdVolumeContentManifest',
      contractId: contract.contractId,
      entries,
    };
    fs.mkdirSync(path.dirname(path.join(mountRoot, contract.sentinelRelativePath)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(mountRoot, contract.sentinelRelativePath), `${JSON.stringify({
      ...payload,
      manifestHash: hashRecord('ColdVolumeContentManifest', payload),
    })}\n`);
  };
  const mountedStorage = {
    target: mountRoot,
    source: '/dev/test1',
    fstype: 'ext4',
    uuid: expectedStorageIdentity.filesystemUuid,
    partuuid: expectedStorageIdentity.partitionUuid,
    id: directoryMountId(mountRoot),
    'maj:min': deviceMajorMinor(mountRoot),
    fsroot: '/',
  };
  writeSentinel([]);
  const incomplete = verifyColdVolumeContract({
    assetRoot,
    contract,
    mountAvailableOverride: true,
    mountedStorageOverride: mountedStorage,
  });
  assert.ok(incomplete.blockers.includes('cold_volume_content_manifest_entries_mismatch'));
  assert.equal(incomplete.storageIdentityMatchesContract, true);

  writeSentinel(['derivatives']);
  const wrongStorage = verifyColdVolumeContract({
    assetRoot,
    contract,
    mountAvailableOverride: true,
    mountedStorageOverride: {
      ...mountedStorage,
      uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    },
  });
  assert.ok(wrongStorage.blockers.includes('cold_volume_storage_identity_mismatch'));
  assert.equal(wrongStorage.storageIdentityMatchesContract, false);

  const wrongDevice = verifyColdVolumeContract({
    assetRoot,
    contract,
    mountAvailableOverride: true,
    mountedStorageOverride: {
      ...mountedStorage,
      'maj:min': '4095:1048575',
    },
  });
  assert.equal(wrongDevice.mountDeviceMatchesTarget, false);
  assert.equal(wrongDevice.mountBindingStable, false);
  assert.ok(wrongDevice.blockers.includes('cold_volume_mount_device_mismatch'));

  const wrongMountId = verifyColdVolumeContract({
    assetRoot,
    contract,
    mountAvailableOverride: true,
    mountedStorageOverride: {
      ...mountedStorage,
      id: String(Number(mountedStorage.id) + 1),
    },
  });
  assert.equal(wrongMountId.mountIdMatchesTarget, false);
  assert.equal(wrongMountId.mountBindingStable, false);
  assert.ok(wrongMountId.blockers.includes('cold_volume_mount_identity_mismatch'));

  const ready = verifyColdVolumeContract({
    assetRoot,
    contract,
    mountAvailableOverride: true,
    mountedStorageOverride: mountedStorage,
  });
  assert.equal(ready.operationalReplayReady, true);
  assert.equal(ready.storageIdentityMatchesContract, true);
  assert.equal(ready.mountDeviceMatchesTarget, true);
  assert.equal(ready.mountIdMatchesTarget, true);
  assert.equal(ready.mountBindingStable, true);
  assert.deepEqual(ready.targetDirectoryIdentity, {
    dev: String(fs.lstatSync(mountRoot, { bigint: true }).dev),
    ino: String(fs.lstatSync(mountRoot, { bigint: true }).ino),
  });
  assert.equal(ready.targetDeviceMajorMinor, deviceMajorMinor(mountRoot));
  assert.equal(ready.targetMountId, directoryMountId(mountRoot));
  assert.match(ready.mountObservationHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(ready.expectedStorageIdentityHash, /^sha256:[a-f0-9]{64}$/u);
});

test('cold-volume contract rejects an A/B/A mount observation during content reprobe', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-volume-aba-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const mountRoot = path.join(root, 'mount');
  const logicalRoot = path.join(assetRoot, 'drafts', 'NDU_Nature_work');
  const contentRoot = path.join(mountRoot, 'cold', 'NDU_Nature_work');
  fs.mkdirSync(logicalRoot, { recursive: true });
  fs.mkdirSync(path.join(contentRoot, 'derivatives'), { recursive: true });
  fs.symlinkSync(
    path.join(contentRoot, 'derivatives'),
    path.join(logicalRoot, 'derivatives'),
  );
  const contract = {
    version: 1,
    kind: 'ColdVolumeMountContract',
    contractId: 'fixture-aba-v1',
    mountRoot,
    contentRoot: 'cold/NDU_Nature_work',
    sentinelRelativePath: 'cold/HEPTA_COLD_VOLUME_MANIFEST.json',
    contentManifestRequiredWhenMounted: false,
    entries: ['derivatives'],
  };
  const observationA = {
    target: mountRoot,
    source: '/dev/fixture-a',
    fstype: 'ext4',
    uuid: '11111111-1111-1111-1111-111111111111',
    partuuid: '22222222-2222-2222-2222-222222222222',
    id: directoryMountId(mountRoot),
    'maj:min': deviceMajorMinor(mountRoot),
    fsroot: '/',
  };
  const observationB = { ...observationA, source: '/dev/transient-b', fsroot: '/transient' };
  let selectedObservation = observationA;
  let probeCount = 0;
  const status = verifyColdVolumeContract({
    assetRoot,
    contract,
    mountAvailableOverride: true,
    mountedStorageOverride: ({ phase }) => {
      probeCount += 1;
      const observed = selectedObservation;
      selectedObservation = phase === 'before_content' ? observationB : observationA;
      return observed;
    },
  });
  assert.equal(probeCount, 2);
  assert.equal(selectedObservation, observationA);
  assert.equal(status.mountDeviceMatchesTarget, true);
  assert.equal(status.mountIdMatchesTarget, true);
  assert.equal(status.mountBindingStable, false);
  assert.equal(status.operationalReplayReady, false);
  assert.ok(status.blockers.includes('cold_volume_mount_binding_changed'));
});

test('production cold-volume contract retires all historical derived entries from v0.21', (t) => {
  const retirementRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-retirement-'));
  t.after(() => fs.rmSync(retirementRoot, { recursive: true, force: true }));
  const contract = JSON.parse(fs.readFileSync(path.join(
    WORKSPACE_ROOT,
    'paper-core',
    'config',
    'cold-volume-contract.v1.json',
  ), 'utf8'));
  assert.equal(contract.contractId, 'ndu-nature-work-toshiba-inventory-smr-v3');
  assert.equal(contract.mountRoot, '/mnt/hepta-paper-external');
  assert.doesNotMatch(JSON.stringify(contract), /THUNDERO/u);
  assert.equal(contract.availabilityPolicy, 'inventory_only_not_release_blocking');
  assert.equal(contract.contentManifestRequiredWhenMounted, false);
  assert.deepEqual(contract.expectedStorageIdentity, {
    filesystemType: 'ext4',
    filesystemUuid: '39324240-9c85-4d8a-a1b2-711f26c4ff77',
    partitionUuid: '7cb85044-3be4-4756-9c7e-bfd6be3eb49f',
  });
  assert.deepEqual(contract.storageAccessPolicy, {
    mediaTechnology: 'smr',
    sourceReadPolicy: 'sequential_read_only',
    writerPolicy: 'single_writer_append_new_files_only',
    inPlaceMutationAllowed: false,
    coldCasRoot: '/data/home-data/hepta-paper-cold-object-store',
    coldCasPlacementPolicy: 'must_not_share_cold_volume',
  });
  assert.deepEqual(contract.rawDatasetRoots.map((entry) => ({
    datasetId: entry.datasetId,
    role: entry.role,
  })), [
    { datasetId: 'openneuro:ds000030', role: 'raw_source_only_not_derived_artifact' },
    { datasetId: 'openneuro:ds004323', role: 'raw_source_only_not_derived_artifact' },
    { datasetId: 'openneuro:ds005364', role: 'raw_source_only_not_derived_artifact' },
  ]);
  assert.deepEqual(contract.releaseScope, {
    releaseLine: '0.21',
    status: 'historical_derived_entries_retired',
    decisionId: 'retire-ndu-derived-v0.21-20260811',
    decisionDate: '2026-08-11',
    supersededContractId: 'ndu-nature-work-thundero-ext4-v1',
    supersededContractFileSha256:
      'sha256:14910f0f3fcc421c216edeb3f88b77a6dc95612f750085d6b8424c544eb8b15f',
    activeEntryCount: 0,
    retiredEntryCount: 15,
    retiredInventoryHash:
      'sha256:1e61b97e31be781278512a5cf716642af0d0c86beddd9da25e21c255ab36ad38',
    coldCasRequired: false,
    rawDatasetRootsReleaseBlocking: false,
  });
  assert.deepEqual(contract.entries, []);
  assert.equal(contract.retiredEntries.length, 15);
  assert.equal(new Set(contract.retiredEntries.map((entry) => entry.relative)).size, 15);
  assert.equal(
    contract.retiredEntries.filter((entry) => entry.priorDisposition === 'rebuildable').length,
    6,
  );
  assert.equal(
    contract.retiredEntries.filter((entry) => entry.priorDisposition === 'missing').length,
    9,
  );
  assert.ok(contract.retiredEntries.every((entry) => (
    entry.reason === 'operator_retired_from_v0.21_release_scope'
  )));
  assert.ok(contract.retiredEntries.filter((entry) => entry.priorDisposition === 'rebuildable')
    .every((entry) => entry.relative.includes('fmriprep_work')));
  const status = verifyColdVolumeContract({
    assetRoot: retirementRoot,
    contract,
    mountAvailableOverride: false,
  });
  assert.equal(status.contractValid, true);
  assert.equal(status.releaseScopeRetired, true);
  assert.equal(status.releaseGateSatisfied, true);
  assert.equal(status.operationalReplayReady, false);
  assert.equal(status.retiredEntryCount, 15);
  assert.equal(status.entryCount, 0);
  assert.equal(status.retiredLogicalPathCount, 0);
  assert.equal(status.status, 'cold_volume_release_scope_retired');
  assert.match(status.releaseScopeHash, /^sha256:[a-f0-9]{64}$/u);

  const retiredLogicalPath = path.join(
    retirementRoot, 'drafts', 'NDU_Nature_work', contract.retiredEntries[0].relative,
  );
  fs.mkdirSync(path.dirname(retiredLogicalPath), { recursive: true });
  fs.symlinkSync('/deliberately-missing-retired-target', retiredLogicalPath);
  const silentlyReexposed = verifyColdVolumeContract({
    assetRoot: retirementRoot,
    contract,
    mountAvailableOverride: false,
  });
  assert.equal(silentlyReexposed.contractValid, false);
  assert.equal(silentlyReexposed.releaseGateSatisfied, false);
  assert.equal(silentlyReexposed.retiredLogicalPathCount, 1);
  assert.ok(silentlyReexposed.blockers.includes(
    `cold_volume_retired_logical_path_present:${contract.retiredEntries[0].relative}`,
  ));
  fs.unlinkSync(retiredLogicalPath);

  const truncated = structuredClone(contract);
  truncated.retiredEntries.pop();
  truncated.releaseScope.retiredEntryCount = truncated.retiredEntries.length;
  truncated.releaseScope.retiredInventoryHash = hashRecord(
    'ColdVolumeRetiredEntryInventory',
    [...truncated.retiredEntries]
      .sort((left, right) => left.relative.localeCompare(right.relative)),
  );
  const failOpenAttempt = verifyColdVolumeContract({
    assetRoot: retirementRoot,
    contract: truncated,
    mountAvailableOverride: false,
  });
  assert.equal(failOpenAttempt.contractValid, false);
  assert.equal(failOpenAttempt.releaseScopeRetired, false);
  assert.equal(failOpenAttempt.releaseGateSatisfied, false);
  assert.ok(failOpenAttempt.blockers.includes('cold_volume_release_scope_retirement_invalid'));
});

test('raw source availability cannot masquerade as a present derived entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-raw-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const mountRoot = path.join(root, 'mount');
  const rawRoot = path.join(mountRoot, 'neural_datasets', 'raw');
  const contentRoot = path.join(mountRoot, 'cold', 'NDU_Nature_work');
  const logicalRoot = path.join(assetRoot, 'drafts', 'NDU_Nature_work');
  fs.mkdirSync(rawRoot, { recursive: true });
  fs.mkdirSync(contentRoot, { recursive: true });
  fs.mkdirSync(logicalRoot, { recursive: true });
  const expectedTarget = path.join(contentRoot, 'derivatives');
  fs.symlinkSync(rawRoot, expectedTarget, 'dir');
  fs.symlinkSync(expectedTarget, path.join(logicalRoot, 'derivatives'), 'dir');
  const contract = {
    version: 1,
    kind: 'ColdVolumeMountContract',
    contractId: 'raw-alias-fixture-v1',
    mountRoot,
    contentRoot: 'cold/NDU_Nature_work',
    sentinelRelativePath: 'cold/HEPTA_COLD_VOLUME_MANIFEST.json',
    contentManifestRequiredWhenMounted: true,
    storageAccessPolicy: {
      mediaTechnology: 'smr',
      sourceReadPolicy: 'sequential_read_only',
      writerPolicy: 'single_writer_append_new_files_only',
      inPlaceMutationAllowed: false,
      coldCasRoot: path.join(root, 'cas'),
      coldCasPlacementPolicy: 'must_not_share_cold_volume',
    },
    rawDatasetRoots: [{
      datasetId: 'fixture:raw',
      relativePath: 'neural_datasets/raw',
      role: 'raw_source_only_not_derived_artifact',
    }],
    entries: ['derivatives'],
    entryDispositions: [{
      relative: 'derivatives',
      disposition: 'present',
      reason: 'derived_artifact_verified_present',
      relatedRawDatasetIds: ['fixture:raw'],
    }],
  };
  const sentinelPayload = {
    version: 1,
    kind: 'ColdVolumeContentManifest',
    contractId: contract.contractId,
    entries: ['derivatives'],
  };
  fs.writeFileSync(path.join(mountRoot, contract.sentinelRelativePath), `${JSON.stringify({
    ...sentinelPayload,
    manifestHash: hashRecord('ColdVolumeContentManifest', sentinelPayload),
  })}\n`);
  const status = verifyColdVolumeContract({
    assetRoot,
    contract,
    mountAvailableOverride: true,
  });
  assert.equal(status.rawDatasetRows[0].present, true);
  assert.equal(status.presentDispositionCount, 1);
  assert.equal(status.operationalReplayReady, false);
  assert.ok(status.blockers.includes('cold_volume_required_content_unsafe:derivatives'));
  assert.ok(status.blockers.includes(
    'cold_volume_derived_entry_aliases_raw_dataset:derivatives:fixture:raw',
  ));
});

test('missing and rebuildable dispositions both remain operational blockers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-disposition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const mountRoot = path.join(root, 'mount');
  const rawRoot = path.join(mountRoot, 'raw');
  const logicalRoot = path.join(assetRoot, 'drafts', 'NDU_Nature_work');
  fs.mkdirSync(rawRoot, { recursive: true });
  fs.mkdirSync(logicalRoot, { recursive: true });
  const contract = {
    version: 1,
    kind: 'ColdVolumeMountContract',
    contractId: 'disposition-fixture-v1',
    mountRoot,
    contentRoot: 'cold/NDU_Nature_work',
    sentinelRelativePath: 'cold/HEPTA_COLD_VOLUME_MANIFEST.json',
    contentManifestRequiredWhenMounted: false,
    rawDatasetRoots: [{
      datasetId: 'fixture:raw',
      relativePath: 'raw',
      role: 'raw_source_only_not_derived_artifact',
    }],
    entries: ['derivatives', 'fmriprep_work'],
    entryDispositions: [{
      relative: 'derivatives',
      disposition: 'missing',
      reason: 'derived_artifact_not_located_on_toshiba',
      relatedRawDatasetIds: ['fixture:raw'],
    }, {
      relative: 'fmriprep_work',
      disposition: 'rebuildable',
      reason: 'rebuildable_work_cache_from_bound_raw_dataset',
      relatedRawDatasetIds: ['fixture:raw'],
    }],
  };
  for (const relative of contract.entries) {
    fs.symlinkSync(
      path.join(mountRoot, contract.contentRoot, relative),
      path.join(logicalRoot, relative),
    );
  }
  const status = verifyColdVolumeContract({
    assetRoot,
    contract,
    mountAvailableOverride: true,
  });
  assert.equal(status.missingDispositionCount, 1);
  assert.equal(status.rebuildableDispositionCount, 1);
  assert.equal(status.presentDispositionCount, 0);
  assert.equal(status.operationalReplayReady, false);
  assert.ok(status.blockers.includes(
    'cold_volume_entry_disposition_not_present:derivatives:missing',
  ));
  assert.ok(status.blockers.includes(
    'cold_volume_entry_disposition_not_present:fmriprep_work:rebuildable',
  ));
});
