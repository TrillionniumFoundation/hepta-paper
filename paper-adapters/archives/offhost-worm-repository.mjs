import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

function filesystemImmutable(file) {
  const probe = spawnSync('lsattr', ['-d', file], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  const attributes = String(probe.stdout || '').trim().split(/\s+/, 1)[0] || '';
  return attributes.includes('i');
}

function semverParts(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-|$)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function resolveLatestReleaseEvidencePointer(runtimeRoot) {
  const evidenceRoot = path.join(runtimeRoot, 'release-evidence');
  if (!fs.existsSync(evidenceRoot)) return null;
  const candidates = [];
  for (const version of fs.readdirSync(evidenceRoot)) {
    if (!semverParts(version)) continue;
    const versionRoot = path.join(evidenceRoot, version);
    if (!fs.statSync(versionRoot).isDirectory()) continue;
    for (const commit of fs.readdirSync(versionRoot)) {
      const pointerPath = path.join(versionRoot, commit, 'CURRENT_RELEASE_EVIDENCE.json');
      if (!fs.existsSync(pointerPath)) continue;
      try {
        const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
        if (pointer?.kind !== 'CurrentReleaseEvidencePointer' || pointer.packageVersion !== version) continue;
        candidates.push({ pointerPath, version, generatedAt: String(pointer.generatedAt || ''), commit });
      } catch { /* Ignore corrupt candidates; source validation will still fail closed. */ }
    }
  }
  candidates.sort((left, right) => compareSemver(left.version, right.version)
    || left.generatedAt.localeCompare(right.generatedAt)
    || left.commit.localeCompare(right.commit));
  return candidates.at(-1)?.pointerPath || null;
}

export function verifyOffhostWormTarget({ workspaceRoot, contract, mountAvailableOverride = null, distinctDeviceOverride = null } = {}) {
  if (contract?.kind !== 'OffhostWormSnapshotContract' || contract?.version !== 1) throw new Error('v1 offhost WORM contract required');
  const targetMountRoot = path.resolve(process.env.HEPTA_OFFHOST_WORM_ROOT || contract.targetMountRoot);
  const mountProbe = spawnSync('findmnt', ['-rn', '--mountpoint', targetMountRoot, '-o', 'TARGET,SOURCE,FSTYPE'], { encoding: 'utf8' });
  const mountAvailable = mountAvailableOverride === null ? mountProbe.status === 0 : Boolean(mountAvailableOverride);
  let distinctDevice = false;
  if (mountAvailable) {
    try {
      distinctDevice = fs.statSync(path.resolve(workspaceRoot)).dev !== fs.statSync(targetMountRoot).dev;
    } catch { distinctDevice = false; }
  }
  if (distinctDeviceOverride !== null) distinctDevice = Boolean(distinctDeviceOverride);
  const blockers = [
    ...(mountAvailable ? [] : ['offhost_worm_target_unavailable']),
    ...(contract.requireDistinctFilesystemDevice && !distinctDevice ? ['offhost_worm_target_not_distinct_device'] : []),
  ];
  return Object.freeze({
    version: 1,
    kind: 'OffhostWormTargetStatus',
    status: blockers.length ? 'offhost_worm_target_blocked' : 'offhost_worm_target_ready',
    contractId: contract.contractId,
    targetMountRoot,
    mountAvailable,
    mountIdentity: mountAvailable ? String(mountProbe.stdout || '').trim() || 'test_override' : null,
    distinctDevice,
    currentProtectionLevel: contract.currentProtectionLevel || 'external_disk_unspecified_custody',
    offHostOrOffsiteCustodyQualified: contract.offHostOrOffsiteCustodyQualified === true,
    custodyStatus: contract.offHostOrOffsiteCustodyQualified === true
      ? 'offhost_or_offsite_custody_qualified'
      : 'offhost_or_offsite_custody_blocked',
    custodyBlockers: contract.offHostOrOffsiteCustodyQualified === true
      ? []
      : [
        ...(contract.offlineDetachmentOrObjectLockReceiptRequired ? ['offline_detachment_or_object_lock_receipt_missing'] : []),
        ...(contract.independentCustodyAttestationRequired ? ['independent_custody_attestation_missing'] : []),
      ],
    blockers,
  });
}

export function createOffhostWormSnapshot({ workspaceRoot, contract, sources = [], execute = false, mountAvailableOverride = null, distinctDeviceOverride = null, immutableOverride = null } = {}) {
  const target = verifyOffhostWormTarget({ workspaceRoot, contract, mountAvailableOverride, distinctDeviceOverride });
  const blockers = [...target.blockers, ...(execute ? [] : ['offhost_worm_snapshot_execute_required'])];
  const sourceRows = sources.map((source) => ({
    role: source.role,
    path: path.resolve(source.path),
    present: fs.existsSync(source.path),
    sha256: fs.existsSync(source.path) ? sha256FileSync(source.path) : null,
    bytes: fs.existsSync(source.path) ? fs.statSync(source.path).size : 0,
  }));
  for (const source of sourceRows) if (!source.present) blockers.push(`offhost_worm_source_missing:${source.role}`);
  if (blockers.length) {
    return Object.freeze({
      version: 1,
      kind: 'OffhostWormSnapshotReceipt',
      status: 'offhost_worm_snapshot_blocked',
      execute,
      target,
      sources: sourceRows,
      copiedObjectCount: 0,
      immutableObjectCount: 0,
      blockers: [...new Set(blockers)],
    });
  }
  const subject = { contractId: contract.contractId, sources: sourceRows.map(({ role, sha256, bytes }) => ({ role, sha256, bytes })) };
  const snapshotId = hashRecord('OffhostWormSnapshotSubject', subject).replace(/^sha256:/, '');
  const snapshotRoot = path.join(target.targetMountRoot, 'hepta-paper-worm', snapshotId);
  const objectRoot = path.join(snapshotRoot, 'objects');
  fs.mkdirSync(objectRoot, { recursive: true });
  const objects = [];
  for (const source of sourceRows) {
    const token = source.sha256.replace(/^sha256:/, '');
    const destination = path.join(objectRoot, token);
    if (!fs.existsSync(destination)) {
      fs.copyFileSync(source.path, destination);
      fs.chmodSync(destination, 0o444);
    }
    const objectHash = sha256FileSync(destination);
    if (objectHash !== source.sha256) blockers.push(`offhost_worm_object_hash_mismatch:${source.role}`);
    let immutable = Boolean(immutableOverride);
    if (immutableOverride === null) {
      if (!filesystemImmutable(destination)) spawnSync('chattr', ['+i', destination], { encoding: 'utf8' });
      immutable = filesystemImmutable(destination);
    }
    objects.push({ role: source.role, sourceHash: source.sha256, objectPath: destination, objectHash, immutable });
  }
  if (contract.requireFilesystemImmutableObjects && objects.some((object) => !object.immutable)) blockers.push('offhost_worm_objects_not_filesystem_immutable');
  if (blockers.length) {
    return Object.freeze({
      version: 1,
      kind: 'OffhostWormSnapshotReceipt',
      status: 'offhost_worm_snapshot_blocked',
      execute: true,
      target,
      sources: sourceRows,
      objects,
      copiedObjectCount: objects.length,
      immutableObjectCount: objects.filter((object) => object.immutable).length,
      blockers: [...new Set(blockers)],
    });
  }
  const payload = {
    version: 1,
    kind: 'OffhostWormSnapshotManifest',
    contractId: contract.contractId,
    snapshotId,
    protectionLevel: target.currentProtectionLevel,
    offHostOrOffsiteCustodyQualified: target.offHostOrOffsiteCustodyQualified,
    objects,
  };
  const manifest = { ...payload, manifestHash: hashRecord('OffhostWormSnapshotManifest', payload) };
  const manifestPath = path.join(snapshotRoot, 'OFFHOST_WORM_SNAPSHOT_MANIFEST.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
  return Object.freeze({
    version: 1,
    kind: 'OffhostWormSnapshotReceipt',
    status: 'offhost_worm_snapshot_recorded',
    execute: true,
    target,
    snapshotRoot,
    manifestPath,
    manifestHash: manifest.manifestHash,
    copiedObjectCount: objects.length,
    immutableObjectCount: objects.filter((object) => object.immutable).length,
    blockers: [],
  });
}

export function drillOffhostWormRestore({ manifestPath, immutableOverride = null } = {}) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return Object.freeze({ version: 1, kind: 'OffhostWormRestoreDrillReceipt', status: 'offhost_worm_restore_drill_blocked', blockers: ['offhost_worm_manifest_missing'] });
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const payload = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'manifestHash'));
  const blockers = [];
  const invalidRoles = new Set();
  if (hashRecord('OffhostWormSnapshotManifest', payload) !== manifest.manifestHash) blockers.push('offhost_worm_manifest_hash_invalid');
  for (const object of manifest.objects || []) {
    if (!fs.existsSync(object.objectPath)) {
      blockers.push(`offhost_worm_object_missing:${object.role}`);
      invalidRoles.add(object.role);
    } else if (sha256FileSync(object.objectPath) !== object.sourceHash) {
      blockers.push(`offhost_worm_object_hash_mismatch:${object.role}`);
      invalidRoles.add(object.role);
    }
    const immutable = immutableOverride === null ? filesystemImmutable(object.objectPath) : Boolean(immutableOverride);
    if (object.immutable !== true || !immutable) {
      blockers.push(`offhost_worm_object_not_immutable:${object.role}`);
      invalidRoles.add(object.role);
    }
  }
  return Object.freeze({
    version: 1,
    kind: 'OffhostWormRestoreDrillReceipt',
    status: blockers.length ? 'offhost_worm_restore_drill_blocked' : 'offhost_worm_restore_drill_passed',
    manifestHash: manifest.manifestHash || null,
    verifiedObjectCount: (manifest.objects || []).length - invalidRoles.size,
    blockers,
  });
}
