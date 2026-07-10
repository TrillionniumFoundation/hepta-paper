import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyColdVolumeContract } from './cold-volume-contract.mjs';

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function objectPath(casRoot, hash) {
  const token = String(hash).replace(/^sha256:/, '');
  return path.join(casRoot, 'objects', token.slice(0, 2), `${token}.tar.gz`);
}

function latestManifest(casRoot) {
  const root = path.join(casRoot, 'manifests');
  if (!fs.existsSync(root)) return null;
  const rows = fs.readdirSync(root).filter((name) => name.endsWith('.json')).sort();
  return rows.length ? path.join(root, rows.at(-1)) : null;
}

export function coldVolumeCasStatus({ casRoot } = {}) {
  const manifestPath = latestManifest(casRoot);
  if (!manifestPath) {
    return Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasStatus',
      status: 'cold_volume_cas_manifest_missing',
      casRoot,
      manifestPath: null,
      objectCount: 0,
      blockers: ['cold_volume_cas_manifest_missing'],
    });
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const payload = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'manifestHash'));
  const blockers = [];
  if (hashRecord('ColdVolumeCasManifest', payload) !== manifest.manifestHash) blockers.push('cold_volume_cas_manifest_hash_invalid');
  for (const entry of manifest.entries || []) {
    const file = objectPath(casRoot, entry.objectHash);
    if (!fs.existsSync(file)) blockers.push(`cold_volume_cas_object_missing:${entry.relative}`);
    else if (sha256File(file) !== entry.objectHash) blockers.push(`cold_volume_cas_object_hash_mismatch:${entry.relative}`);
  }
  return Object.freeze({
    version: 1,
    kind: 'ColdVolumeCasStatus',
    status: blockers.length ? 'cold_volume_cas_blocked' : 'cold_volume_cas_ready',
    casRoot,
    manifestPath,
    manifestHash: manifest.manifestHash || null,
    contractHash: manifest.contractHash || null,
    objectCount: manifest.entries?.length || 0,
    blockers,
  });
}

export function importColdVolumeToCas({ assetRoot, contract, contractPath, casRoot, execute = false, mountAvailableOverride = null } = {}) {
  const contractStatus = verifyColdVolumeContract({ assetRoot, contract, contractPath, mountAvailableOverride });
  const blockers = [...contractStatus.blockers];
  if (!execute) blockers.push('cold_volume_cas_import_execute_required');
  if (!contractStatus.operationalReplayReady) blockers.push('cold_volume_operational_replay_not_ready');
  if (blockers.length) {
    return Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasImportReceipt',
      status: 'cold_volume_cas_import_blocked',
      execute,
      casRoot,
      contractStatus,
      importedObjectCount: 0,
      externalActionPerformed: false,
      blockers: [...new Set(blockers)],
    });
  }
  const contentRoot = path.join(path.resolve(contract.mountRoot), contract.contentRoot);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-import-'));
  const entries = [];
  try {
    for (const relative of [...contract.entries].sort()) {
      const tempArchive = path.join(tempRoot, `${crypto.randomUUID()}.tar.gz`);
      const tar = spawnSync('tar', [
        '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
        '-czf', tempArchive, '-C', contentRoot, '--', relative,
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (tar.status !== 0) throw new Error(tar.stderr || `cold_volume_cas_archive_failed:${relative}`);
      const objectHash = sha256File(tempArchive);
      const target = objectPath(casRoot, objectHash);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.copyFileSync(tempArchive, target);
      fs.chmodSync(target, 0o444);
      entries.push({ relative, objectHash, bytes: fs.statSync(target).size });
    }
    const payload = {
      version: 1,
      kind: 'ColdVolumeCasManifest',
      contractId: contract.contractId,
      contractHash: contractStatus.contractHash,
      entryCount: entries.length,
      entries,
    };
    const manifest = { ...payload, manifestHash: hashRecord('ColdVolumeCasManifest', payload) };
    const manifestRoot = path.join(casRoot, 'manifests');
    fs.mkdirSync(manifestRoot, { recursive: true });
    const manifestPath = path.join(manifestRoot, `${manifest.manifestHash.replace(/^sha256:/, '')}.json`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
    return Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasImportReceipt',
      status: 'cold_volume_cas_imported',
      execute: true,
      casRoot,
      manifestPath,
      manifestHash: manifest.manifestHash,
      importedObjectCount: entries.length,
      externalActionPerformed: false,
      blockers: [],
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function drillColdVolumeCasRestore({ casRoot } = {}) {
  const status = coldVolumeCasStatus({ casRoot });
  if (status.status !== 'cold_volume_cas_ready') {
    return Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasRestoreDrillReceipt',
      status: 'cold_volume_cas_restore_drill_blocked',
      casRoot,
      restoredObjectCount: 0,
      blockers: status.blockers,
    });
  }
  const manifest = JSON.parse(fs.readFileSync(status.manifestPath, 'utf8'));
  const restoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-restore-'));
  const blockers = [];
  try {
    for (const entry of manifest.entries || []) {
      const file = objectPath(casRoot, entry.objectHash);
      const extract = spawnSync('tar', ['-xzf', file, '-C', restoreRoot], { encoding: 'utf8' });
      if (extract.status !== 0 || !fs.existsSync(path.join(restoreRoot, entry.relative))) {
        blockers.push(`cold_volume_cas_restore_failed:${entry.relative}`);
      }
    }
    return Object.freeze({
      version: 1,
      kind: 'ColdVolumeCasRestoreDrillReceipt',
      status: blockers.length ? 'cold_volume_cas_restore_drill_blocked' : 'cold_volume_cas_restore_drill_passed',
      casRoot,
      manifestHash: manifest.manifestHash,
      restoredObjectCount: (manifest.entries || []).length - blockers.length,
      blockers,
    });
  } finally {
    fs.rmSync(restoreRoot, { recursive: true, force: true });
  }
}
