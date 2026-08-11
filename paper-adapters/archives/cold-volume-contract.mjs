import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/u;
const ENTRY_DISPOSITIONS = new Set(['missing', 'present', 'rebuildable']);
const DISPOSITION_REASONS = Object.freeze({
  missing: 'derived_artifact_not_located_on_toshiba',
  present: 'derived_artifact_verified_present',
  rebuildable: 'rebuildable_work_cache_from_bound_raw_dataset',
});
const RELEASE_SCOPE_KEYS = Object.freeze([
  'activeEntryCount',
  'coldCasRequired',
  'decisionDate',
  'decisionId',
  'rawDatasetRootsReleaseBlocking',
  'releaseLine',
  'retiredEntryCount',
  'retiredInventoryHash',
  'status',
  'supersededContractFileSha256',
  'supersededContractId',
]);
const RETIRED_ENTRY_KEYS = Object.freeze([
  'priorDisposition', 'reason', 'relatedRawDatasetIds', 'relative',
]);
const RETIRED_ENTRY_REASON = 'operator_retired_from_v0.21_release_scope';
const V021_RETIRED_ENTRY_COUNT = 15;
const V021_RETIRED_ENTRY_INVENTORY_HASH =
  'sha256:1e61b97e31be781278512a5cf716642af0d0c86beddd9da25e21c255ab36ad38';
const V021_SUPERSEDED_CONTRACT_FILE_HASH =
  'sha256:14910f0f3fcc421c216edeb3f88b77a6dc95612f750085d6b8424c544eb8b15f';

function directoryIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function deviceMajorMinor(device) {
  const value = BigInt(device);
  const major = ((value & 0x00000000000fff00n) >> 8n)
    | ((value & 0xfffff00000000000n) >> 32n);
  const minor = (value & 0x00000000000000ffn)
    | ((value & 0x00000ffffff00000n) >> 12n);
  return `${major}:${minor}`;
}

function descriptorMountId(descriptor, fileSystem = fs) {
  const match = fileSystem.readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8')
    .match(/^mnt_id:\s*([0-9]+)$/mu);
  if (!match) throw new Error('cold_volume_mount_id_unavailable');
  return match[1];
}

function mountedStorageObservation(mountedStorage) {
  if (!mountedStorage || typeof mountedStorage !== 'object' || Array.isArray(mountedStorage)) {
    return null;
  }
  return Object.freeze({
    target: String(mountedStorage.target || ''),
    source: String(mountedStorage.source || ''),
    fstype: String(mountedStorage.fstype || ''),
    uuid: String(mountedStorage.uuid || '').toLowerCase(),
    partuuid: String(mountedStorage.partuuid || '').toLowerCase(),
    mountId: String(mountedStorage.id || mountedStorage.mountId || ''),
    majorMinor: String(mountedStorage['maj:min'] || mountedStorage.majorMinor || ''),
    fsRoot: String(mountedStorage.fsroot || mountedStorage.fsRoot || ''),
  });
}

function probeMountedStorage(mountRoot, mountedStorageOverride, phase) {
  if (mountedStorageOverride !== null) {
    try {
      const mountedStorage = typeof mountedStorageOverride === 'function'
        ? mountedStorageOverride({ mountRoot, phase }) : mountedStorageOverride;
      return Object.freeze({ status: mountedStorage ? 0 : 1, mountedStorage });
    } catch {
      return Object.freeze({ status: 1, mountedStorage: null });
    }
  }
  const probe = spawnSync(
    'findmnt',
    [
      '-J', '-n', '--mountpoint', mountRoot,
      '-o', 'TARGET,SOURCE,FSTYPE,UUID,PARTUUID,ID,MAJ:MIN,FSROOT',
    ],
    { encoding: 'utf8' },
  );
  let mountedStorage = null;
  try { [mountedStorage] = JSON.parse(probe.stdout).filesystems; } catch { /* blocked below */ }
  return Object.freeze({ status: probe.status, mountedStorage });
}

function expectedStorageIdentity(contract) {
  if (contract?.expectedStorageIdentity === undefined) return null;
  const identity = contract.expectedStorageIdentity;
  if (identity === null || typeof identity !== 'object'
    || Array.isArray(identity)
    || Object.keys(identity).sort().join(',')
      !== 'filesystemType,filesystemUuid,partitionUuid'
    || typeof identity.filesystemType !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{1,31}$/u.test(identity.filesystemType)
    || !UUID.test(String(identity.filesystemUuid || '').toLowerCase())
    || !UUID.test(String(identity.partitionUuid || '').toLowerCase())) {
    throw new Error('cold_volume_storage_identity_contract_invalid');
  }
  return Object.freeze({
    filesystemType: identity.filesystemType,
    filesystemUuid: identity.filesystemUuid.toLowerCase(),
    partitionUuid: identity.partitionUuid.toLowerCase(),
  });
}

function mountedStorageMatchesExpected(mountedStorage, expected) {
  if (!expected) return true;
  return mountedStorage?.fstype === expected.filesystemType
    && String(mountedStorage?.uuid || '').toLowerCase() === expected.filesystemUuid
    && String(mountedStorage?.partuuid || '').toLowerCase() === expected.partitionUuid;
}

function manifestEntriesMatchContract(sentinel, expected) {
  if (!Array.isArray(sentinel?.entries)
    || sentinel.entries.some((entry) => typeof entry !== 'string' || !entry)) return false;
  const entries = [...new Set(sentinel.entries)].sort();
  return entries.length === expected.length
    && entries.every((entry, index) => entry === expected[index]);
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

export function inspectColdVolumeReleaseScope(contract = {}) {
  const activeEntries = Array.isArray(contract?.entries) ? contract.entries : [];
  const releaseScope = contract?.releaseScope;
  const retiredEntries = contract?.retiredEntries;
  const declared = releaseScope !== undefined || retiredEntries !== undefined;
  const blockers = [];
  if (!declared) {
    if (activeEntries.length === 0) {
      blockers.push('cold_volume_release_scope_empty_without_retirement');
    }
    return Object.freeze({
      blockers: Object.freeze(blockers),
      declared: false,
      hash: null,
      releaseScopeRetired: false,
      retiredEntries: Object.freeze([]),
    });
  }
  if (!Array.isArray(retiredEntries) || retiredEntries.length === 0) {
    blockers.push('cold_volume_retired_entry_inventory_invalid');
  }
  const seen = new Set();
  const normalizedRetiredEntries = (Array.isArray(retiredEntries) ? retiredEntries : [])
    .map((entry) => {
      const relatedRawDatasetIds = Array.isArray(entry?.relatedRawDatasetIds)
        ? entry.relatedRawDatasetIds.map(String) : [];
      const relative = String(entry?.relative || 'invalid');
      const valid = exactKeys(entry, RETIRED_ENTRY_KEYS)
        && safeRelative(relative)
        && !seen.has(relative)
        && ['missing', 'present', 'rebuildable'].includes(entry.priorDisposition)
        && entry.reason === RETIRED_ENTRY_REASON
        && relatedRawDatasetIds.length > 0
        && JSON.stringify(relatedRawDatasetIds)
          === JSON.stringify([...new Set(relatedRawDatasetIds)].sort());
      if (!valid) blockers.push('cold_volume_retired_entry_inventory_invalid');
      seen.add(relative);
      return Object.freeze({
        relative,
        priorDisposition: entry?.priorDisposition || null,
        reason: entry?.reason || null,
        relatedRawDatasetIds: Object.freeze(relatedRawDatasetIds),
      });
    });
  if (normalizedRetiredEntries.some((entry) => activeEntries.includes(entry.relative))) {
    blockers.push('cold_volume_active_and_retired_entry_overlap');
  }
  const retiredInventoryHash = hashRecord(
    'ColdVolumeRetiredEntryInventory',
    [...normalizedRetiredEntries].sort((left, right) => left.relative.localeCompare(right.relative)),
  );
  const scopeValid = exactKeys(releaseScope, RELEASE_SCOPE_KEYS)
    && releaseScope.releaseLine === '0.21'
    && releaseScope.status === 'historical_derived_entries_retired'
    && SAFE_ID.test(String(releaseScope.decisionId || ''))
    && /^\d{4}-\d{2}-\d{2}$/u.test(String(releaseScope.decisionDate || ''))
    && releaseScope.supersededContractId === 'ndu-nature-work-thundero-ext4-v1'
    && releaseScope.supersededContractFileSha256 === V021_SUPERSEDED_CONTRACT_FILE_HASH
    && releaseScope.activeEntryCount === 0
    && releaseScope.retiredEntryCount === V021_RETIRED_ENTRY_COUNT
    && retiredEntries?.length === V021_RETIRED_ENTRY_COUNT
    && releaseScope.retiredInventoryHash === V021_RETIRED_ENTRY_INVENTORY_HASH
    && retiredInventoryHash === V021_RETIRED_ENTRY_INVENTORY_HASH
    && releaseScope.coldCasRequired === false
    && releaseScope.rawDatasetRootsReleaseBlocking === false
    && activeEntries.length === 0;
  if (!scopeValid) blockers.push('cold_volume_release_scope_retirement_invalid');
  const payload = {
    releaseScope: releaseScope && typeof releaseScope === 'object' ? releaseScope : null,
    retiredEntries: Array.isArray(retiredEntries) ? retiredEntries : [],
  };
  return Object.freeze({
    blockers: Object.freeze([...new Set(blockers)]),
    declared: true,
    hash: hashRecord('ColdVolumeReleaseScopeRetirement', payload),
    releaseScopeRetired: blockers.length === 0,
    retiredEntries: Object.freeze(normalizedRetiredEntries),
  });
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function safeDirectoryObservation(candidate, fileSystem = fs) {
  const selected = path.resolve(candidate);
  try {
    const stat = fileSystem.lstatSync(selected, { bigint: true });
    const realPath = fileSystem.realpathSync(selected);
    const safe = stat.isDirectory() && !stat.isSymbolicLink() && realPath === selected;
    return Object.freeze({
      present: true,
      safe,
      realPath,
      identity: directoryIdentity(stat),
    });
  } catch {
    return Object.freeze({ present: false, safe: false, realPath: null, identity: null });
  }
}

function openPinnedMountDirectory(candidate, fileSystem = fs) {
  const selected = path.resolve(candidate);
  let descriptor;
  try {
    const selectedStat = fileSystem.lstatSync(selected, { bigint: true });
    if (!selectedStat.isDirectory() || selectedStat.isSymbolicLink()
      || fileSystem.realpathSync(selected) !== selected) {
      throw new Error('cold_volume_mount_root_unsafe');
    }
    descriptor = fileSystem.openSync(
      selected,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | NO_FOLLOW,
    );
    const opened = fileSystem.fstatSync(descriptor, { bigint: true });
    const identity = directoryIdentity(opened);
    if (!opened.isDirectory() || !sameIdentity(directoryIdentity(selectedStat), identity)) {
      throw new Error('cold_volume_mount_root_unsafe');
    }
    return Object.freeze({
      descriptor,
      identity,
      majorMinor: deviceMajorMinor(opened.dev),
      mountId: descriptorMountId(descriptor, fileSystem),
    });
  } catch (error) {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    throw error;
  }
}

function pinnedMountDirectoryStable(pinned, mountRoot, fileSystem = fs) {
  try {
    const opened = fileSystem.fstatSync(pinned.descriptor, { bigint: true });
    const current = fileSystem.lstatSync(mountRoot, { bigint: true });
    return opened.isDirectory() && current.isDirectory() && !current.isSymbolicLink()
      && sameIdentity(directoryIdentity(opened), pinned.identity)
      && sameIdentity(directoryIdentity(current), pinned.identity)
      && deviceMajorMinor(opened.dev) === pinned.majorMinor
      && descriptorMountId(pinned.descriptor, fileSystem) === pinned.mountId
      && fileSystem.realpathSync(mountRoot) === mountRoot;
  } catch {
    return false;
  }
}

function inspectStorageAccessPolicy(contract, mountRoot) {
  if (contract?.storageAccessPolicy === undefined) {
    return Object.freeze({ blockers: Object.freeze([]), hash: null, policy: null });
  }
  const policy = contract.storageAccessPolicy;
  const blockers = [];
  if (!exactKeys(policy, [
    'coldCasPlacementPolicy', 'coldCasRoot', 'inPlaceMutationAllowed',
    'mediaTechnology', 'sourceReadPolicy', 'writerPolicy',
  ])) {
    blockers.push('cold_volume_storage_access_policy_schema_invalid');
  }
  const coldCasRoot = typeof policy?.coldCasRoot === 'string'
    && path.isAbsolute(policy.coldCasRoot) ? path.resolve(policy.coldCasRoot) : null;
  if (policy?.mediaTechnology !== 'smr'
    || policy?.sourceReadPolicy !== 'sequential_read_only'
    || policy?.writerPolicy !== 'single_writer_append_new_files_only'
    || policy?.inPlaceMutationAllowed !== false
    || policy?.coldCasPlacementPolicy !== 'must_not_share_cold_volume'
    || !coldCasRoot || within(mountRoot, coldCasRoot)) {
    blockers.push('cold_volume_storage_access_policy_invalid');
  }
  return Object.freeze({
    blockers: Object.freeze([...new Set(blockers)]),
    hash: exactKeys(policy, [
      'coldCasPlacementPolicy', 'coldCasRoot', 'inPlaceMutationAllowed',
      'mediaTechnology', 'sourceReadPolicy', 'writerPolicy',
    ]) ? hashRecord('ColdVolumeStorageAccessPolicy', policy) : null,
    policy: policy && typeof policy === 'object' && !Array.isArray(policy)
      ? Object.freeze({ ...policy, coldCasRoot }) : null,
  });
}

function inspectDataDisposition(
  contract,
  mountRoot,
  expected,
  { fileSystem = fs, observeContent = false, releaseScopeInspection = null } = {},
) {
  if (contract?.rawDatasetRoots === undefined
    && contract?.entryDispositions === undefined
    && releaseScopeInspection?.declared !== true) {
    return Object.freeze({
      blockers: Object.freeze([]),
      dispositionByRelative: new Map(),
      hash: null,
      rawDatasetRows: Object.freeze([]),
      required: false,
    });
  }
  const blockers = [];
  const rawDefinitions = Array.isArray(contract.rawDatasetRoots)
    ? contract.rawDatasetRoots : [];
  const dispositionDefinitions = Array.isArray(contract.entryDispositions)
    ? contract.entryDispositions : [];
  if ((contract.rawDatasetRoots !== undefined
      && (!Array.isArray(contract.rawDatasetRoots) || !rawDefinitions.length))
    || (expected.length > 0
      && (!Array.isArray(contract.entryDispositions) || !dispositionDefinitions.length))
    || (expected.length === 0 && contract.entryDispositions !== undefined
      && (!Array.isArray(contract.entryDispositions) || dispositionDefinitions.length > 0))) {
    blockers.push('cold_volume_disposition_contract_schema_invalid');
  }
  const rawIds = new Set();
  const rawDatasetRows = rawDefinitions.map((definition) => {
    const shapeValid = exactKeys(definition, ['datasetId', 'relativePath', 'role']);
    const datasetId = String(definition?.datasetId || 'invalid');
    const relativePath = String(definition?.relativePath || 'invalid');
    const definitionValid = shapeValid && SAFE_ID.test(datasetId)
      && safeRelative(relativePath)
      && definition.role === 'raw_source_only_not_derived_artifact'
      && !rawIds.has(datasetId);
    if (!definitionValid) blockers.push('cold_volume_raw_dataset_contract_invalid');
    if (definitionValid) rawIds.add(datasetId);
    const rawPath = path.resolve(mountRoot, relativePath);
    const observation = observeContent && within(mountRoot, rawPath)
      ? safeDirectoryObservation(rawPath, fileSystem)
      : Object.freeze({ present: false, safe: false, realPath: null, identity: null });
    return Object.freeze({
      datasetId,
      relativePath,
      role: definition?.role || null,
      path: rawPath,
      present: observation.present,
      safe: definitionValid && observation.safe,
      realPath: observation.realPath,
      identity: observation.identity,
    });
  });
  const dispositionByRelative = new Map();
  for (const definition of dispositionDefinitions) {
    const relative = String(definition?.relative || 'invalid');
    const relatedRawDatasetIds = Array.isArray(definition?.relatedRawDatasetIds)
      ? definition.relatedRawDatasetIds.map(String) : [];
    const sortedRawDatasetIds = [...new Set(relatedRawDatasetIds)].sort();
    const valid = exactKeys(definition, [
      'disposition', 'reason', 'relatedRawDatasetIds', 'relative',
    ]) && safeRelative(relative) && expected.includes(relative)
      && !dispositionByRelative.has(relative)
      && ENTRY_DISPOSITIONS.has(definition.disposition)
      && definition.reason === DISPOSITION_REASONS[definition.disposition]
      && relatedRawDatasetIds.length > 0
      && JSON.stringify(relatedRawDatasetIds) === JSON.stringify(sortedRawDatasetIds)
      && relatedRawDatasetIds.every((datasetId) => rawIds.has(datasetId));
    if (!valid) blockers.push('cold_volume_entry_disposition_contract_invalid');
    if (valid) dispositionByRelative.set(relative, Object.freeze({
      disposition: definition.disposition,
      reason: definition.reason,
      relatedRawDatasetIds: Object.freeze(relatedRawDatasetIds),
    }));
  }
  for (const retired of releaseScopeInspection?.retiredEntries || []) {
    if (retired.relatedRawDatasetIds.some((datasetId) => !rawIds.has(datasetId))) {
      blockers.push('cold_volume_retired_entry_raw_dataset_reference_invalid');
    }
  }
  if (JSON.stringify([...dispositionByRelative.keys()].sort()) !== JSON.stringify(expected)) {
    blockers.push('cold_volume_entry_disposition_inventory_mismatch');
  }
  for (const relative of expected) {
    const disposition = dispositionByRelative.get(relative);
    if (!disposition) continue;
    if (disposition.disposition !== 'present') {
      blockers.push(
        `cold_volume_entry_disposition_not_present:${relative}:${disposition.disposition}`,
      );
    }
  }
  const payload = Object.freeze({
    rawDatasetRoots: rawDefinitions,
    entryDispositions: dispositionDefinitions,
  });
  return Object.freeze({
    blockers: Object.freeze([...new Set(blockers)]),
    dispositionByRelative,
    hash: hashRecord('ColdVolumeDataDisposition', payload),
    rawDatasetRows: Object.freeze(rawDatasetRows),
    required: expected.length > 0,
  });
}

function inspectDerivedTarget(
  candidate,
  rawDatasetRows,
  { fileSystem = fs, observeContent = false } = {},
) {
  const selected = path.resolve(candidate);
  const observation = observeContent
    ? safeDirectoryObservation(selected, fileSystem)
    : Object.freeze({ present: false, safe: false, realPath: null, identity: null });
  const rawDatasetAliases = observation.realPath ? rawDatasetRows.filter((row) => (
    row.safe && row.realPath && within(row.realPath, observation.realPath)
  )).map((row) => row.datasetId).sort() : [];
  return Object.freeze({
    present: observation.present,
    safe: observation.safe && rawDatasetAliases.length === 0,
    realPath: observation.realPath,
    rawDatasetAliases: Object.freeze(rawDatasetAliases),
  });
}

export function verifyColdVolumeContract({
  assetRoot,
  contract,
  contractPath = null,
  mountAvailableOverride = null,
  mountedStorageOverride = null,
  fileSystem = fs,
} = {}) {
  if (!assetRoot || contract?.kind !== 'ColdVolumeMountContract' || contract?.version !== 1) {
    throw new Error('A v1 ColdVolumeMountContract and assetRoot are required');
  }
  const mountRoot = path.resolve(String(contract.mountRoot || ''));
  const contentRoot = path.join(mountRoot, contract.contentRoot);
  const logicalRoot = path.join(
    path.resolve(String(assetRoot || '')),
    'drafts',
    'NDU_Nature_work',
  );
  const expected = [...new Set(contract.entries || [])].sort();
  const releaseScopeInspection = inspectColdVolumeReleaseScope(contract);
  const storageAccessPolicy = inspectStorageAccessPolicy(contract, mountRoot);
  const mountProbe = probeMountedStorage(mountRoot, mountedStorageOverride, 'before_content');
  const mountObservation = mountedStorageObservation(mountProbe.mountedStorage);
  const mountAvailable = mountAvailableOverride === null
    ? mountProbe.status === 0 && mountObservation?.target === mountRoot
    : Boolean(mountAvailableOverride);
  const expectedIdentity = expectedStorageIdentity(contract);
  const storageIdentityMatchesContract = mountAvailable
    ? mountedStorageMatchesExpected(mountObservation, expectedIdentity) : false;
  const mountObservationHash = mountAvailable && mountObservation
    ? hashRecord('ColdVolumeMountObservation', mountObservation) : null;
  const fixtureMountOverride = mountAvailableOverride !== null && !mountObservation;
  let pinnedMount = null;
  if (mountAvailable) {
    try { pinnedMount = openPinnedMountDirectory(mountRoot, fileSystem); }
    catch { /* represented by targetPathSafe and blockers below */ }
  }
  const targetPathSafe = Boolean(pinnedMount);
  const targetDirectoryIdentity = pinnedMount?.identity || null;
  const targetDeviceMajorMinor = pinnedMount?.majorMinor || null;
  const targetMountId = pinnedMount?.mountId || null;
  const mountDeviceMatchesTarget = targetPathSafe && (
    mountObservation
      ? mountObservation.target === mountRoot
        && mountObservation.majorMinor === targetDeviceMajorMinor
      : fixtureMountOverride
  );
  const mountIdMatchesTarget = targetPathSafe && (
    mountObservation
      ? mountObservation.mountId === targetMountId && mountObservation.fsRoot.length > 0
      : fixtureMountOverride
  );
  const observeContent = mountAvailable && targetPathSafe
    && mountDeviceMatchesTarget && mountIdMatchesTarget
    && storageIdentityMatchesContract;
  let dataDisposition;
  let rows;
  let retiredLogicalPathCount = 0;
  let sentinelHash = null;
  let directoryBindingStable = false;
  let observationBindingStable = false;
  const blockers = [
    ...storageAccessPolicy.blockers,
    ...releaseScopeInspection.blockers,
  ];
  const sentinelPath = path.join(mountRoot, contract.sentinelRelativePath);
  try {
    dataDisposition = inspectDataDisposition(contract, mountRoot, expected, {
      fileSystem,
      observeContent,
      releaseScopeInspection,
    });
    blockers.push(...dataDisposition.blockers);
    rows = expected.map((relative) => {
      const logicalPath = path.join(logicalRoot, relative);
      const expectedTarget = path.join(contentRoot, relative);
      let kind = 'missing';
      let actualTarget = null;
      try {
        const stat = fileSystem.lstatSync(logicalPath);
        kind = stat.isSymbolicLink()
          ? 'symlink'
          : stat.isDirectory()
            ? 'directory'
            : stat.isFile() ? 'file' : 'other';
        if (stat.isSymbolicLink()) {
          actualTarget = path.resolve(
            path.dirname(logicalPath),
            fileSystem.readlinkSync(logicalPath),
          );
        }
      } catch { /* represented as missing */ }
      const target = inspectDerivedTarget(expectedTarget, dataDisposition.rawDatasetRows, {
        fileSystem,
        observeContent,
      });
      const disposition = dataDisposition.dispositionByRelative.get(relative) || null;
      const targetMatches = kind === 'symlink' && actualTarget === path.resolve(expectedTarget);
      if (!targetMatches) blockers.push(`cold_volume_link_contract_mismatch:${relative}`);
      if (target.present && !target.safe) {
        blockers.push(`cold_volume_required_content_unsafe:${relative}`);
      }
      for (const datasetId of target.rawDatasetAliases) {
        blockers.push(`cold_volume_derived_entry_aliases_raw_dataset:${relative}:${datasetId}`);
      }
      return {
        relative,
        logicalPath,
        kind,
        expectedTarget: path.resolve(expectedTarget),
        actualTarget,
        targetMatches,
        targetPresent: target.present,
        targetSafe: target.safe,
        targetRealPath: target.realPath,
        rawDatasetAliases: target.rawDatasetAliases,
        disposition: disposition?.disposition || (dataDisposition.required
          ? 'invalid_or_missing' : 'legacy_unspecified'),
        dispositionReason: disposition?.reason || null,
        relatedRawDatasetIds: disposition?.relatedRawDatasetIds || [],
      };
    });
    for (const retired of releaseScopeInspection.retiredEntries) {
      const retiredLogicalPath = path.join(logicalRoot, retired.relative);
      try {
        fileSystem.lstatSync(retiredLogicalPath);
        retiredLogicalPathCount += 1;
        blockers.push(`cold_volume_retired_logical_path_present:${retired.relative}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          blockers.push(`cold_volume_retired_logical_path_unsafe:${retired.relative}`);
        }
      }
    }
    if (observeContent) {
      for (const raw of dataDisposition.rawDatasetRows) {
        if (!raw.present || !raw.safe) {
          blockers.push(`cold_volume_raw_dataset_root_missing_or_unsafe:${raw.datasetId}`);
        }
      }
      let sentinel = null;
      if (contract.contentManifestRequiredWhenMounted) {
        try {
          const sentinelBytes = fileSystem.readFileSync(sentinelPath);
          sentinelHash = hashBytes(sentinelBytes);
          sentinel = JSON.parse(sentinelBytes.toString('utf8'));
        } catch {
          blockers.push('cold_volume_content_manifest_missing_or_invalid');
        }
        if (sentinel && sentinel.version !== 1) {
          blockers.push('cold_volume_content_manifest_version_invalid');
        }
        if (sentinel && sentinel.contractId !== contract.contractId) {
          blockers.push('cold_volume_content_manifest_contract_mismatch');
        }
        if (sentinel && sentinel.kind !== 'ColdVolumeContentManifest') {
          blockers.push('cold_volume_content_manifest_kind_invalid');
        }
        if (sentinel && !manifestEntriesMatchContract(sentinel, expected)) {
          blockers.push('cold_volume_content_manifest_entries_mismatch');
        }
        if (sentinel && (!sentinel.manifestHash || hashRecord(
          'ColdVolumeContentManifest',
          Object.fromEntries(Object.entries(sentinel).filter(([key]) => key !== 'manifestHash')),
        ) !== sentinel.manifestHash)) {
          blockers.push('cold_volume_content_manifest_hash_invalid');
        }
      }
      if (rows.some((row) => !row.targetPresent)) {
        blockers.push('cold_volume_required_content_missing');
      }
    }
    if (targetPathSafe) {
      const freshProbe = mountObservation
        ? probeMountedStorage(mountRoot, mountedStorageOverride, 'after_content')
        : null;
      const freshObservation = mountedStorageObservation(freshProbe?.mountedStorage);
      const freshObservationHash = freshObservation
        ? hashRecord('ColdVolumeMountObservation', freshObservation) : null;
      observationBindingStable = mountObservation
        ? freshProbe?.status === 0
          && freshObservation?.target === mountRoot
          && freshObservation?.majorMinor === targetDeviceMajorMinor
          && freshObservation?.mountId === targetMountId
          && freshObservation?.fsRoot.length > 0
          && freshObservationHash === mountObservationHash
        : fixtureMountOverride;
      directoryBindingStable = pinnedMountDirectoryStable(
        pinnedMount,
        mountRoot,
        fileSystem,
      );
    }
  } finally {
    if (pinnedMount) fileSystem.closeSync(pinnedMount.descriptor);
  }
  const mountBindingStable = targetPathSafe && mountDeviceMatchesTarget
    && mountIdMatchesTarget && directoryBindingStable && observationBindingStable;
  if (!mountAvailable) blockers.push('cold_volume_unavailable');
  if (mountAvailable && expectedIdentity && !storageIdentityMatchesContract) {
    blockers.push('cold_volume_storage_identity_mismatch');
  }
  if (mountAvailable && !targetPathSafe) {
    blockers.push('cold_volume_mount_root_unsafe');
  }
  if (mountAvailable && targetPathSafe && !mountDeviceMatchesTarget) {
    blockers.push('cold_volume_mount_device_mismatch');
  }
  if (mountAvailable && targetPathSafe && !mountIdMatchesTarget) {
    blockers.push('cold_volume_mount_identity_mismatch');
  }
  if (mountAvailable && targetPathSafe && !mountBindingStable) {
    blockers.push('cold_volume_mount_binding_changed');
  }
  const contractValid = blockers.every((item) => ![
    'cold_volume_disposition_contract_',
    'cold_volume_entry_disposition_contract_',
    'cold_volume_entry_disposition_inventory_',
    'cold_volume_link_contract_mismatch',
    'cold_volume_raw_dataset_contract_',
    'cold_volume_release_scope_',
    'cold_volume_retired_entry_',
    'cold_volume_retired_logical_path_',
    'cold_volume_active_and_retired_',
    'cold_volume_storage_access_policy_',
  ].some((prefix) => item.startsWith(prefix)));
  const operationalReplayReady = expected.length > 0
    && contractValid && mountAvailable && mountBindingStable
    && blockers.length === 0
    && rows.every((row) => row.targetPresent && row.targetSafe
      && ['legacy_unspecified', 'present'].includes(row.disposition));
  const releaseGateSatisfied = contractValid
    && (releaseScopeInspection.releaseScopeRetired || operationalReplayReady);
  const payload = {
    version: 1,
    kind: 'ColdVolumeMountContractStatus',
    status: !contractValid
      ? 'cold_volume_contract_blocked'
      : releaseScopeInspection.releaseScopeRetired
        ? 'cold_volume_release_scope_retired'
      : operationalReplayReady
        ? 'cold_volume_mounted_and_content_verified'
        : mountAvailable
          ? 'cold_volume_mounted_but_content_incomplete'
          : 'cold_volume_contract_verified_volume_unavailable',
    contractId: contract.contractId,
    contractHash: contractPath ? sha256FileSync(contractPath) : hashRecord('ColdVolumeMountContract', contract),
    assetRoot: path.resolve(String(assetRoot || '')),
    mountRoot,
    mountAvailable,
    mountIdentity: mountAvailable
      ? mountObservation ? JSON.stringify(mountObservation) : 'test_override'
      : null,
    mountObservationHash,
    targetDirectoryIdentity,
    targetDeviceMajorMinor,
    targetMountId,
    mountDeviceMatchesTarget,
    mountIdMatchesTarget,
    mountBindingStable,
    expectedStorageIdentityHash: expectedIdentity
      ? hashRecord('ColdVolumeExpectedStorageIdentity', expectedIdentity) : null,
    storageIdentityMatchesContract,
    storageAccessPolicyHash: storageAccessPolicy.hash,
    coldCasRoot: storageAccessPolicy.policy?.coldCasRoot || null,
    dispositionHash: dataDisposition.hash,
    releaseScopeHash: releaseScopeInspection.hash,
    releaseScopeRetired: releaseScopeInspection.releaseScopeRetired,
    releaseGateSatisfied,
    retiredEntryCount: releaseScopeInspection.retiredEntries.length,
    retiredLogicalPathCount,
    rawDatasetRootCount: dataDisposition.rawDatasetRows.length,
    presentDispositionCount: rows.filter((row) => row.disposition === 'present').length,
    rebuildableDispositionCount: rows.filter((row) => row.disposition === 'rebuildable').length,
    missingDispositionCount: rows.filter((row) => row.disposition === 'missing').length,
    rawDatasetRows: dataDisposition.rawDatasetRows,
    sentinelPath,
    sentinelHash,
    entryCount: rows.length,
    contractValid,
    operationalReplayReady,
    blockers,
    rows,
  };
  return Object.freeze({ ...payload, statusHash: hashRecord('ColdVolumeMountContractStatus', payload) });
}
