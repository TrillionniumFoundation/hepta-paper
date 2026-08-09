import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  coldVolumeCasStatus,
  drillColdVolumeCasRestore,
  importColdVolumeToCas,
} from '../../paper-adapters/archives/cold-volume-cas-repository.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const mountRoot = path.join(root, 'mount');
  const contentRoot = path.join(mountRoot, 'cold', 'NDU_Nature_work');
  const logicalRoot = path.join(assetRoot, 'drafts', 'NDU_Nature_work');
  const casRoot = path.join(root, 'cas');
  fs.mkdirSync(path.join(contentRoot, 'derivatives'), { recursive: true });
  fs.writeFileSync(path.join(contentRoot, 'derivatives', 'result.txt'), 'verified\n');
  fs.mkdirSync(logicalRoot, { recursive: true });
  fs.symlinkSync(path.join(contentRoot, 'derivatives'), path.join(logicalRoot, 'derivatives'));
  const contract = {
    version: 1,
    kind: 'ColdVolumeMountContract',
    contractId: 'cas-fixture-v1',
    mountRoot,
    contentRoot: 'cold/NDU_Nature_work',
    sentinelRelativePath: 'cold/HEPTA_COLD_VOLUME_MANIFEST.json',
    contentManifestRequiredWhenMounted: false,
    entries: ['derivatives'],
  };
  const contractPath = path.join(root, 'cold-volume-contract.json');
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  return { assetRoot, casRoot, contentRoot, contract, contractPath, root };
}

function writeManifest(casRoot, payload) {
  const manifest = {
    ...payload,
    manifestHash: hashRecord('ColdVolumeCasManifest', payload),
  };
  const manifestRoot = path.join(casRoot, 'manifests');
  fs.rmSync(manifestRoot, { recursive: true, force: true });
  fs.mkdirSync(manifestRoot, { recursive: true, mode: 0o755 });
  fs.chmodSync(casRoot, 0o755);
  fs.chmodSync(manifestRoot, 0o755);
  const manifestPath = path.join(
    manifestRoot,
    `${manifest.manifestHash.slice('sha256:'.length)}.json`,
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o444 });
  fs.writeFileSync(path.join(manifestRoot, 'current.json'), `${JSON.stringify({
    version: 1,
    kind: 'ColdVolumeCasCurrentManifest',
    manifestHash: manifest.manifestHash,
  })}\n`, { mode: 0o444 });
  return { manifest, manifestPath };
}

function publishArchive(casRoot, contract, archive) {
  const objectHash = sha256FileSync(archive);
  const token = objectHash.slice('sha256:'.length);
  const object = path.join(casRoot, 'objects', token.slice(0, 2), `${token}.tar.gz`);
  fs.mkdirSync(path.dirname(object), { recursive: true, mode: 0o755 });
  fs.chmodSync(casRoot, 0o755);
  fs.chmodSync(path.join(casRoot, 'objects'), 0o755);
  fs.chmodSync(path.dirname(object), 0o755);
  fs.copyFileSync(archive, object);
  fs.chmodSync(object, 0o444);
  writeManifest(casRoot, {
    version: 1,
    kind: 'ColdVolumeCasManifest',
    contractId: contract.contractId,
    contractHash: hashRecord('ColdVolumeMountContract', contract),
    entryCount: 1,
    entries: [{ relative: 'derivatives', objectHash, bytes: fs.statSync(object).size }],
  });
  return Object.freeze({ object, objectHash });
}

test('cold-volume content imports to content-addressed objects and restores', (t) => {
  const { assetRoot, casRoot, contract, contractPath } = fixture(t);
  const imported = importColdVolumeToCas({
    assetRoot, casRoot, contract, contractPath, execute: true, mountAvailableOverride: true,
  });
  assert.equal(imported.status, 'cold_volume_cas_imported');
  assert.equal(imported.importedObjectCount, 1);
  assert.equal(coldVolumeCasStatus({ casRoot, contract, contractPath }).status, 'cold_volume_cas_ready');
  const drill = drillColdVolumeCasRestore({ casRoot, contract, contractPath });
  assert.equal(drill.status, 'cold_volume_cas_restore_drill_passed');
  assert.equal(drill.restoredObjectCount, 1);
  assert.equal(drill.expectedObjectCount, 1);
});

test('current manifest pointer selects the last accepted import instead of the largest digest', (t) => {
  const { assetRoot, casRoot, contentRoot, contract, contractPath } = fixture(t);
  let largest = null;
  let last = null;
  for (let version = 0; version < 64; version += 1) {
    fs.writeFileSync(
      path.join(contentRoot, 'derivatives', 'result.txt'),
      `verified-version-${version}\n`,
    );
    const imported = importColdVolumeToCas({
      assetRoot, casRoot, contract, contractPath, execute: true, mountAvailableOverride: true,
    });
    assert.equal(imported.status, 'cold_volume_cas_imported');
    last = imported;
    if (largest !== null && imported.manifestHash < largest) break;
    if (largest === null || imported.manifestHash > largest) largest = imported.manifestHash;
  }
  assert.ok(last.manifestHash < largest, 'fixture did not produce a lower later digest');
  const status = coldVolumeCasStatus({ casRoot, contract, contractPath });
  assert.equal(status.status, 'cold_volume_cas_ready');
  assert.equal(status.manifestHash, last.manifestHash);
  const drill = drillColdVolumeCasRestore({ casRoot, contract, contractPath });
  assert.equal(drill.status, 'cold_volume_cas_restore_drill_passed');
  assert.equal(drill.manifestHash, last.manifestHash);
});

test('status and restore require exact immutable publication identity', (t) => {
  const { assetRoot, casRoot, contract, contractPath, root } = fixture(t);
  const imported = importColdVolumeToCas({
    assetRoot, casRoot, contract, contractPath, execute: true, mountAvailableOverride: true,
  });
  const manifest = JSON.parse(fs.readFileSync(imported.manifestPath, 'utf8'));
  const token = manifest.entries[0].objectHash.slice('sha256:'.length);
  const object = path.join(casRoot, 'objects', token.slice(0, 2), `${token}.tar.gz`);
  const pointer = path.join(casRoot, 'manifests', 'current.json');
  const cases = [
    Object.freeze({ candidate: object, alias: path.join(root, 'object-alias') }),
    Object.freeze({ candidate: imported.manifestPath, alias: path.join(root, 'manifest-alias') }),
    Object.freeze({ candidate: pointer, alias: path.join(root, 'pointer-alias') }),
  ];
  for (const selected of cases) {
    fs.chmodSync(selected.candidate, 0o600);
    assert.equal(coldVolumeCasStatus({ casRoot, contract, contractPath }).status,
      'cold_volume_cas_blocked');
    assert.equal(drillColdVolumeCasRestore({ casRoot, contract, contractPath }).status,
      'cold_volume_cas_restore_drill_blocked');
    fs.chmodSync(selected.candidate, 0o444);
    fs.linkSync(selected.candidate, selected.alias);
    assert.equal(coldVolumeCasStatus({ casRoot, contract, contractPath }).status,
      'cold_volume_cas_blocked');
    assert.equal(drillColdVolumeCasRestore({ casRoot, contract, contractPath }).status,
      'cold_volume_cas_restore_drill_blocked');
    fs.unlinkSync(selected.alias);
    assert.equal(coldVolumeCasStatus({ casRoot, contract, contractPath }).status,
      'cold_volume_cas_ready');
  }
});

test('status pins the manifest and complete object tree through one inspection', (t) => {
  const { assetRoot, casRoot, contentRoot, contract, contractPath, root } = fixture(t);
  fs.mkdirSync(path.join(contentRoot, 'supplement'), { recursive: true });
  fs.writeFileSync(path.join(contentRoot, 'supplement', 'more.txt'), 'more evidence\n');
  fs.symlinkSync(
    path.join(contentRoot, 'supplement'),
    path.join(assetRoot, 'drafts', 'NDU_Nature_work', 'supplement'),
  );
  contract.entries.push('supplement');
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  const imported = importColdVolumeToCas({
    assetRoot, casRoot, contract, contractPath, execute: true, mountAvailableOverride: true,
  });
  assert.equal(imported.importedObjectCount, 2);
  const objects = path.join(casRoot, 'objects');
  const relocated = path.join(root, 'relocated-complete-objects');
  const originalReadSync = fs.readSync;
  let replaced = false;
  fs.readSync = function replaceCompleteObjectTree(...arguments_) {
    const bytesRead = originalReadSync.apply(this, arguments_);
    if (!replaced && bytesRead > 0) {
      replaced = true;
      fs.renameSync(objects, relocated);
      fs.mkdirSync(objects, { mode: 0o755 });
    }
    return bytesRead;
  };
  let status;
  try { status = coldVolumeCasStatus({ casRoot, contract, contractPath }); }
  finally { fs.readSync = originalReadSync; }
  assert.equal(replaced, true);
  assert.equal(status.status, 'cold_volume_cas_blocked');
  assert.ok(status.blockers.some((blocker) => blocker.startsWith('cold_volume_cas_object_')));
});

test('manifest and CAS root replacement after selection are never accepted', (t) => {
  const first = fixture(t);
  importColdVolumeToCas({
    ...first, execute: true, mountAvailableOverride: true,
  });
  const relocatedManifests = path.join(first.root, 'relocated-manifests');
  const outsideManifests = path.join(first.root, 'outside-manifests-after-selection');
  fs.mkdirSync(outsideManifests, { mode: 0o755 });
  fs.writeFileSync(path.join(outsideManifests, 'sentinel'), 'untouched\n');
  const manifestDrift = coldVolumeCasStatus({
    casRoot: first.casRoot,
    contract: first.contract,
    contractPath: first.contractPath,
    afterManifestRead() {
      fs.renameSync(path.join(first.casRoot, 'manifests'), relocatedManifests);
      fs.symlinkSync(outsideManifests, path.join(first.casRoot, 'manifests'));
    },
  });
  assert.equal(manifestDrift.status, 'cold_volume_cas_blocked');
  assert.deepEqual(fs.readdirSync(outsideManifests), ['sentinel']);

  const second = fixture(t);
  importColdVolumeToCas({
    ...second, execute: true, mountAvailableOverride: true,
  });
  const relocatedRoot = path.join(second.root, 'relocated-cas-root');
  const rootDrift = coldVolumeCasStatus({
    casRoot: second.casRoot,
    contract: second.contract,
    contractPath: second.contractPath,
    afterManifestRead() {
      fs.renameSync(second.casRoot, relocatedRoot);
      fs.mkdirSync(second.casRoot, { mode: 0o755 });
    },
  });
  assert.equal(rootDrift.status, 'cold_volume_cas_blocked');
});

test('restore receipt includes final manifest identity revalidation', (t) => {
  const { assetRoot, casRoot, contract, contractPath, root } = fixture(t);
  importColdVolumeToCas({
    assetRoot, casRoot, contract, contractPath, execute: true, mountAvailableOverride: true,
  });
  const manifestRoot = path.join(casRoot, 'manifests');
  const relocated = path.join(root, 'restore-relocated-manifests');
  const outside = path.join(root, 'restore-outside-manifests');
  fs.mkdirSync(outside, { mode: 0o755 });
  const originalMkdtempSync = fs.mkdtempSync;
  let replaced = false;
  fs.mkdtempSync = function replaceManifestAfterInspection(prefix, ...rest) {
    const created = originalMkdtempSync.call(this, prefix, ...rest);
    if (!replaced && String(prefix).includes('hepta-cold-cas-restore-')) {
      replaced = true;
      fs.renameSync(manifestRoot, relocated);
      fs.symlinkSync(outside, manifestRoot);
    }
    return created;
  };
  let drill;
  try { drill = drillColdVolumeCasRestore({ casRoot, contract, contractPath }); }
  finally { fs.mkdtempSync = originalMkdtempSync; }
  assert.equal(replaced, true);
  assert.equal(drill.status, 'cold_volume_cas_restore_drill_blocked');
});

test('a self-consistent empty or foreign-contract manifest is never ready', (t) => {
  const { casRoot, contract, root } = fixture(t);
  const contractHash = hashRecord('ColdVolumeMountContract', contract);
  const empty = writeManifest(casRoot, {
    version: 1,
    kind: 'ColdVolumeCasManifest',
    contractId: contract.contractId,
    contractHash,
    entryCount: 0,
    entries: [],
  });
  const emptyStatus = coldVolumeCasStatus({ casRoot, contract });
  assert.equal(emptyStatus.status, 'cold_volume_cas_blocked');
  assert.ok(emptyStatus.blockers.includes('cold_volume_cas_manifest_entries_empty'));
  assert.ok(emptyStatus.blockers.includes('cold_volume_cas_manifest_inventory_mismatch'));
  assert.equal(emptyStatus.manifestHash, empty.manifest.manifestHash);

  const outsideManifest = path.join(root, 'outside-manifest.json');
  fs.copyFileSync(empty.manifestPath, outsideManifest);
  fs.unlinkSync(empty.manifestPath);
  fs.symlinkSync(outsideManifest, empty.manifestPath);
  const symlinked = coldVolumeCasStatus({ casRoot, contract });
  assert.equal(symlinked.status, 'cold_volume_cas_blocked');
  assert.deepEqual(symlinked.blockers, ['cold_volume_cas_manifest_unsafe_or_invalid']);

  writeManifest(casRoot, {
    version: 1,
    kind: 'ColdVolumeCasManifest',
    contractId: 'forged-contract',
    contractHash: `sha256:${'1'.repeat(64)}`,
    entryCount: 1,
    entries: [{ relative: 'derivatives', objectHash: `sha256:${'2'.repeat(64)}`, bytes: 1 }],
  });
  const forged = coldVolumeCasStatus({ casRoot, contract });
  assert.equal(forged.status, 'cold_volume_cas_blocked');
  assert.ok(forged.blockers.includes('cold_volume_cas_manifest_contract_binding_mismatch'));
});

test('manifest entries require a unique safe exact contract inventory and object size', (t) => {
  const { casRoot, contract } = fixture(t);
  writeManifest(casRoot, {
    version: 1,
    kind: 'ColdVolumeCasManifest',
    contractId: contract.contractId,
    contractHash: hashRecord('ColdVolumeMountContract', contract),
    entryCount: 2,
    entries: [
      { relative: '../derivatives', objectHash: `sha256:${'2'.repeat(64)}`, bytes: 0 },
      { relative: '../derivatives', objectHash: 'not-a-hash', bytes: -1 },
    ],
  });
  const status = coldVolumeCasStatus({ casRoot, contract });
  assert.equal(status.status, 'cold_volume_cas_blocked');
  assert.ok(status.blockers.includes('cold_volume_cas_manifest_entry_relative_invalid'));
  assert.ok(status.blockers.includes('cold_volume_cas_manifest_object_hash_invalid'));
  assert.ok(status.blockers.includes('cold_volume_cas_manifest_object_size_invalid'));
  assert.ok(status.blockers.includes('cold_volume_cas_manifest_inventory_mismatch'));

  writeManifest(casRoot, {
    version: 1,
    kind: 'ColdVolumeCasManifest',
    contractId: contract.contractId,
    contractHash: hashRecord('ColdVolumeMountContract', contract),
    entryCount: 2,
    entries: [
      { relative: 'derivatives', objectHash: `sha256:${'2'.repeat(64)}`, bytes: 1 },
      { relative: 'derivatives', objectHash: `sha256:${'3'.repeat(64)}`, bytes: 1 },
    ],
  });
  const duplicate = coldVolumeCasStatus({ casRoot, contract });
  assert.equal(duplicate.status, 'cold_volume_cas_blocked');
  assert.ok(duplicate.blockers.includes('cold_volume_cas_manifest_entry_relative_duplicate'));
});

test('status rejects symlinked CAS objects with no-follow inspection', (t) => {
  const { assetRoot, casRoot, contract, root } = fixture(t);
  const imported = importColdVolumeToCas({
    assetRoot, contract, casRoot, execute: true, mountAvailableOverride: true,
  });
  const manifest = JSON.parse(fs.readFileSync(imported.manifestPath, 'utf8'));
  const { manifestHash: ignoredManifestHash, ...payload } = manifest;
  writeManifest(casRoot, {
    ...payload,
    entries: payload.entries.map((entry) => ({ ...entry, bytes: entry.bytes + 1 })),
  });
  const wrongSize = coldVolumeCasStatus({ casRoot, contract });
  assert.equal(wrongSize.status, 'cold_volume_cas_blocked');
  assert.deepEqual(wrongSize.blockers, ['cold_volume_cas_object_size_mismatch:derivatives']);
  writeManifest(casRoot, payload);
  const objectHash = manifest.entries[0].objectHash.slice('sha256:'.length);
  const object = path.join(casRoot, 'objects', objectHash.slice(0, 2), `${objectHash}.tar.gz`);
  const outside = path.join(root, 'outside.tar.gz');
  fs.copyFileSync(object, outside);
  fs.unlinkSync(object);
  fs.symlinkSync(outside, object);
  const status = coldVolumeCasStatus({ casRoot, contract });
  assert.equal(status.status, 'cold_volume_cas_blocked');
  assert.deepEqual(status.blockers, ['cold_volume_cas_object_unsafe:derivatives']);
});

test('status and restore reject a CAS object shard relocated behind a symlink', (t) => {
  const { assetRoot, casRoot, contract, root } = fixture(t);
  const imported = importColdVolumeToCas({
    assetRoot, contract, casRoot, execute: true, mountAvailableOverride: true,
  });
  const manifest = JSON.parse(fs.readFileSync(imported.manifestPath, 'utf8'));
  const token = manifest.entries[0].objectHash.slice('sha256:'.length);
  const shard = path.join(casRoot, 'objects', token.slice(0, 2));
  const relocatedShard = path.join(root, 'relocated-object-shard');
  fs.renameSync(shard, relocatedShard);
  fs.symlinkSync(relocatedShard, shard);

  const status = coldVolumeCasStatus({ casRoot, contract });
  assert.equal(status.status, 'cold_volume_cas_blocked');
  assert.deepEqual(status.blockers, ['cold_volume_cas_object_unsafe:derivatives']);

  const drill = drillColdVolumeCasRestore({ casRoot, contract });
  assert.equal(drill.status, 'cold_volume_cas_restore_drill_blocked');
  assert.equal(drill.restoredObjectCount, 0);
  assert.deepEqual(drill.blockers, ['cold_volume_cas_object_unsafe:derivatives']);
});

test('status detects a pinned object shard replaced during hashing', (t) => {
  const { assetRoot, casRoot, contract, root } = fixture(t);
  const imported = importColdVolumeToCas({
    assetRoot, contract, casRoot, execute: true, mountAvailableOverride: true,
  });
  const manifest = JSON.parse(fs.readFileSync(imported.manifestPath, 'utf8'));
  const token = manifest.entries[0].objectHash.slice('sha256:'.length);
  const shard = path.join(casRoot, 'objects', token.slice(0, 2));
  const relocatedShard = path.join(root, 'drifted-object-shard');
  const originalReadSync = fs.readSync;
  let replaced = false;
  fs.readSync = function replaceShardAfterFirstRead(...arguments_) {
    const bytesRead = originalReadSync.apply(this, arguments_);
    if (!replaced && bytesRead > 0) {
      replaced = true;
      fs.renameSync(shard, relocatedShard);
      fs.mkdirSync(shard);
    }
    return bytesRead;
  };
  let status;
  try { status = coldVolumeCasStatus({ casRoot, contract }); }
  finally { fs.readSync = originalReadSync; }

  assert.equal(replaced, true);
  assert.equal(status.status, 'cold_volume_cas_blocked');
  assert.deepEqual(status.blockers, ['cold_volume_cas_object_unsafe:derivatives']);
});

test('execute import cannot escape through a preplaced object shard symlink', (t) => {
  const { assetRoot, casRoot, contract, root } = fixture(t);
  const probeCasRoot = path.join(root, 'probe-cas');
  const probe = importColdVolumeToCas({
    assetRoot, contract, casRoot: probeCasRoot, execute: true, mountAvailableOverride: true,
  });
  const manifest = JSON.parse(fs.readFileSync(probe.manifestPath, 'utf8'));
  const token = manifest.entries[0].objectHash.slice('sha256:'.length);
  const outside = path.join(root, 'outside-object-shard');
  fs.mkdirSync(path.join(casRoot, 'objects'), { recursive: true, mode: 0o755 });
  fs.chmodSync(casRoot, 0o755);
  fs.chmodSync(path.join(casRoot, 'objects'), 0o755);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(casRoot, 'objects', token.slice(0, 2)));

  assert.throws(() => importColdVolumeToCas({
    assetRoot, contract, casRoot, execute: true, mountAvailableOverride: true,
  }), /cold_volume_cas_import_object_unsafe/u);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('execute import cannot escape through a preplaced manifests symlink', (t) => {
  const { assetRoot, casRoot, contract, root } = fixture(t);
  const outside = path.join(root, 'outside-manifests');
  fs.mkdirSync(casRoot, { recursive: true, mode: 0o755 });
  fs.chmodSync(casRoot, 0o755);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(casRoot, 'manifests'));

  assert.throws(() => importColdVolumeToCas({
    assetRoot, contract, casRoot, execute: true, mountAvailableOverride: true,
  }), /cold_volume_cas_import_manifest_unsafe/u);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('restore drill rejects an object whose extracted inventory exceeds its declared relative', (t) => {
  const { casRoot, contract, root } = fixture(t);
  const archiveRoot = path.join(root, 'malicious-archive');
  fs.mkdirSync(path.join(archiveRoot, 'derivatives'), { recursive: true });
  fs.mkdirSync(path.join(archiveRoot, 'unexpected'), { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, 'derivatives', 'result.txt'), 'verified\n');
  fs.writeFileSync(path.join(archiveRoot, 'unexpected', 'extra.txt'), 'extra\n');
  const archive = path.join(root, 'object.tar.gz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', archiveRoot, '--', 'derivatives', 'unexpected'], {
    encoding: 'utf8',
  });
  assert.equal(tar.status, 0, tar.stderr);
  publishArchive(casRoot, contract, archive);
  assert.equal(coldVolumeCasStatus({ casRoot, contract }).status, 'cold_volume_cas_ready');
  const drill = drillColdVolumeCasRestore({ casRoot, contract });
  assert.equal(drill.status, 'cold_volume_cas_restore_drill_blocked');
  assert.equal(drill.restoredObjectCount, 0);
  assert.ok(drill.blockers.includes('cold_volume_cas_restore_inventory_mismatch:derivatives'));
  assert.ok(drill.blockers.includes('cold_volume_cas_restore_exact_inventory_incomplete'));
});

test('restore drill rejects a declared root that is only an external symlink', (t) => {
  const { casRoot, contract, root } = fixture(t);
  const archiveRoot = path.join(root, 'symlink-archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.symlinkSync(path.join(root, 'outside-target'), path.join(archiveRoot, 'derivatives'));
  const archive = path.join(root, 'symlink-object.tar.gz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', archiveRoot, '--', 'derivatives'], {
    encoding: 'utf8',
  });
  assert.equal(tar.status, 0, tar.stderr);
  publishArchive(casRoot, contract, archive);
  assert.equal(coldVolumeCasStatus({ casRoot, contract }).status, 'cold_volume_cas_ready');
  const drill = drillColdVolumeCasRestore({ casRoot, contract });
  assert.equal(drill.status, 'cold_volume_cas_restore_drill_blocked');
  assert.equal(drill.restoredObjectCount, 0);
  assert.ok(drill.blockers.includes(
    'cold_volume_cas_restore_archive_entry_type_unsafe:derivatives',
  ));
});

test('restore drill rejects hardlinks, a file root, and an empty declared directory', (t) => {
  const { casRoot, contract, root } = fixture(t);
  const hardlinkRoot = path.join(root, 'hardlink-archive', 'derivatives');
  fs.mkdirSync(hardlinkRoot, { recursive: true });
  const first = path.join(hardlinkRoot, 'first.txt');
  fs.writeFileSync(first, 'same inode\n');
  fs.linkSync(first, path.join(hardlinkRoot, 'second.txt'));
  const hardlinkArchive = path.join(root, 'hardlink-object.tar.gz');
  const hardlinkTar = spawnSync('tar', [
    '-czf', hardlinkArchive, '-C', path.dirname(hardlinkRoot), '--', 'derivatives',
  ], { encoding: 'utf8' });
  assert.equal(hardlinkTar.status, 0, hardlinkTar.stderr);
  publishArchive(casRoot, contract, hardlinkArchive);
  const hardlinkDrill = drillColdVolumeCasRestore({ casRoot, contract });
  assert.equal(hardlinkDrill.status, 'cold_volume_cas_restore_drill_blocked');
  assert.ok(hardlinkDrill.blockers.includes(
    'cold_volume_cas_restore_archive_entry_type_unsafe:derivatives',
  ));

  const fileRoot = path.join(root, 'file-root-archive');
  fs.mkdirSync(fileRoot, { recursive: true });
  fs.writeFileSync(path.join(fileRoot, 'derivatives'), 'not a directory\n');
  const fileRootArchive = path.join(root, 'file-root-object.tar.gz');
  const fileRootTar = spawnSync('tar', [
    '-czf', fileRootArchive, '-C', fileRoot, '--', 'derivatives',
  ], { encoding: 'utf8' });
  assert.equal(fileRootTar.status, 0, fileRootTar.stderr);
  publishArchive(casRoot, contract, fileRootArchive);
  const fileRootDrill = drillColdVolumeCasRestore({ casRoot, contract });
  assert.equal(fileRootDrill.status, 'cold_volume_cas_restore_drill_blocked');
  assert.ok(fileRootDrill.blockers.includes(
    'cold_volume_cas_restore_declared_root_not_directory:derivatives',
  ));

  const emptyRoot = path.join(root, 'empty-archive', 'derivatives');
  fs.mkdirSync(emptyRoot, { recursive: true });
  const emptyArchive = path.join(root, 'empty-object.tar.gz');
  const emptyTar = spawnSync('tar', [
    '-czf', emptyArchive, '-C', path.dirname(emptyRoot), '--', 'derivatives',
  ], { encoding: 'utf8' });
  assert.equal(emptyTar.status, 0, emptyTar.stderr);
  publishArchive(casRoot, contract, emptyArchive);
  const emptyDrill = drillColdVolumeCasRestore({ casRoot, contract });
  assert.equal(emptyDrill.status, 'cold_volume_cas_restore_drill_blocked');
  assert.ok(emptyDrill.blockers.includes('cold_volume_cas_restore_payload_empty:derivatives'));
});

test('cold-volume CAS release gate fails closed when the manifest is missing', (t) => {
  const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-gate-test-'));
  t.after(() => fs.rmSync(casRoot, { recursive: true, force: true }));
  const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const env = { ...process.env, HEPTA_COLD_OBJECT_STORE_ROOT: casRoot };
  const status = spawnSync(process.execPath, ['paper-core/bin/cold-volume-cas.mjs', 'status'], {
    cwd, env, encoding: 'utf8',
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, 'cold_volume_cas_manifest_missing');

  const releaseGate = spawnSync(process.execPath, [
    'paper-core/bin/cold-volume-cas.mjs', 'status', '--require-ready',
  ], { cwd, env, encoding: 'utf8' });
  assert.equal(releaseGate.status, 1, releaseGate.stderr);
  assert.equal(JSON.parse(releaseGate.stdout).status, 'cold_volume_cas_manifest_missing');

  const manifestRoot = path.join(casRoot, 'manifests');
  fs.mkdirSync(manifestRoot, { mode: 0o755 });
  const invalidManifestPath = path.join(manifestRoot, `${'0'.repeat(64)}.json`);
  fs.writeFileSync(invalidManifestPath, `${JSON.stringify({
    version: 1,
    kind: 'ColdVolumeCasManifest',
    contractId: 'invalid-fixture',
    contractHash: `sha256:${'1'.repeat(64)}`,
    entryCount: 0,
    entries: [],
    manifestHash: `sha256:${'0'.repeat(64)}`,
  })}\n`);
  fs.chmodSync(invalidManifestPath, 0o444);
  fs.writeFileSync(path.join(manifestRoot, 'current.json'), `${JSON.stringify({
    version: 1,
    kind: 'ColdVolumeCasCurrentManifest',
    manifestHash: `sha256:${'0'.repeat(64)}`,
  })}\n`, { mode: 0o444 });
  const invalidGate = spawnSync(process.execPath, [
    'paper-core/bin/cold-volume-cas.mjs', 'status', '--require-ready',
  ], { cwd, env, encoding: 'utf8' });
  assert.equal(invalidGate.status, 1, invalidGate.stderr);
  assert.equal(JSON.parse(invalidGate.stdout).status, 'cold_volume_cas_blocked');
  assert.ok(JSON.parse(invalidGate.stdout).blockers.includes('cold_volume_cas_manifest_hash_invalid'));
  assert.ok(JSON.parse(invalidGate.stdout).blockers.includes('cold_volume_cas_manifest_entries_empty'));
});
