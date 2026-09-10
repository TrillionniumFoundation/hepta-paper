import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  coldVolumeCasStatus,
  drillColdVolumeCasRestore,
  importColdVolumeToCas,
} from '../../paper-adapters/archives/cold-volume-cas-repository.mjs';
import {
  closePinnedCasDirectoryChain,
  openPinnedCasAbsoluteDirectoryChain,
  openPinnedCasChildDirectory,
} from '../../paper-adapters/archives/cold-volume-cas-path-boundary.mjs';
import {
  publishPinnedCasSourceFile,
} from '../../paper-adapters/archives/cold-volume-cas-publication-repository.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

const WORKSPACE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

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

test('formally retired release scope requires no CAS object, import, or restore drill', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-retired-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const casRoot = path.join(root, 'cas-must-not-be-created');
  const contractPath = path.join(
    WORKSPACE_ROOT, 'paper-core', 'config', 'cold-volume-contract.v1.json',
  );
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const status = coldVolumeCasStatus({ casRoot, contract, contractPath });
  assert.equal(status.status, 'cold_volume_cas_not_required');
  assert.equal(status.objectCount, 0);
  assert.deepEqual(status.blockers, []);
  const imported = importColdVolumeToCas({
    assetRoot: path.join(root, 'assets'), casRoot, contract, contractPath, execute: true,
  });
  assert.equal(imported.status, 'cold_volume_cas_import_not_required');
  assert.equal(imported.importedObjectCount, 0);
  assert.equal(imported.externalActionPerformed, false);
  const drill = drillColdVolumeCasRestore({ casRoot, contract, contractPath });
  assert.equal(drill.status, 'cold_volume_cas_restore_drill_not_required');
  assert.equal(drill.expectedObjectCount, 0);
  assert.equal(drill.restoredObjectCount, 0);
  assert.equal(fs.existsSync(casRoot), false);
});

test('reimport preserves an existing CAS inode and consumes its temporary archive', (t) => {
  const selected = fixture(t);
  const first = importColdVolumeToCas({
    ...selected, execute: true, mountAvailableOverride: true,
  });
  const manifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
  const token = manifest.entries[0].objectHash.slice('sha256:'.length);
  const objectPath = path.join(
    selected.casRoot, 'objects', token.slice(0, 2), `${token}.tar.gz`,
  );
  const before = fs.statSync(objectPath, { bigint: true });

  const second = importColdVolumeToCas({
    ...selected, execute: true, mountAvailableOverride: true,
  });
  const after = fs.statSync(objectPath, { bigint: true });
  assert.equal(second.status, 'cold_volume_cas_imported');
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 1n);
  assert.deepEqual(fs.readdirSync(path.join(selected.casRoot, '.staging')), []);
});

test('import uses private CAS-local staging and removes each archive immediately', (t) => {
  const selected = fixture(t);
  const supplement = path.join(selected.contentRoot, 'supplement');
  fs.mkdirSync(supplement);
  fs.writeFileSync(path.join(supplement, 'more.txt'), 'more evidence\n');
  fs.symlinkSync(
    supplement,
    path.join(selected.assetRoot, 'drafts', 'NDU_Nature_work', 'supplement'),
  );
  selected.contract.entries.push('supplement');
  fs.writeFileSync(
    selected.contractPath,
    `${JSON.stringify(selected.contract, null, 2)}\n`,
  );

  const originalUnlinkSync = fs.unlinkSync;
  const removedArchives = [];
  fs.unlinkSync = function observeImmediateArchiveRemoval(candidate, ...arguments_) {
    if (String(candidate).endsWith('.tar.gz')
      && String(candidate).startsWith('/proc/self/fd/')) {
      const parent = path.dirname(String(candidate));
      assert.deepEqual(fs.readdirSync(parent), [path.basename(String(candidate))]);
      const stat = fs.statSync(candidate);
      assert.equal(stat.nlink, 2);
      removedArchives.push(Object.freeze({ dev: stat.dev, ino: stat.ino }));
    }
    return originalUnlinkSync.call(this, candidate, ...arguments_);
  };
  let imported;
  try {
    imported = importColdVolumeToCas({
      ...selected, execute: true, mountAvailableOverride: true,
    });
  } finally { fs.unlinkSync = originalUnlinkSync; }

  assert.equal(imported.status, 'cold_volume_cas_imported');
  assert.equal(imported.importedObjectCount, 2);
  assert.equal(removedArchives.length, 2);
  const manifest = JSON.parse(fs.readFileSync(imported.manifestPath, 'utf8'));
  for (const [index, entry] of manifest.entries.entries()) {
    const token = entry.objectHash.slice('sha256:'.length);
    const object = path.join(selected.casRoot, 'objects', token.slice(0, 2), `${token}.tar.gz`);
    const stat = fs.statSync(object);
    assert.equal(stat.dev, removedArchives[index].dev);
    assert.equal(stat.ino, removedArchives[index].ino);
    assert.equal(stat.nlink, 1);
  }
  const staging = path.join(selected.casRoot, '.staging');
  const stagingStat = fs.statSync(staging);
  assert.equal(stagingStat.mode & 0o7777, 0o700);
  assert.equal(stagingStat.dev, fs.statSync(selected.casRoot).dev);
  assert.deepEqual(fs.readdirSync(staging), []);
});

test('explicit import staging must be private and on the CAS filesystem', (t) => {
  const selected = fixture(t);
  const stagingRoot = path.join(selected.root, 'explicit-staging');
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  const imported = importColdVolumeToCas({
    ...selected,
    execute: true,
    mountAvailableOverride: true,
    stagingRoot,
  });
  assert.equal(imported.status, 'cold_volume_cas_imported');
  assert.deepEqual(fs.readdirSync(stagingRoot), []);

  const unsafe = fixture(t);
  const publicStaging = path.join(unsafe.root, 'public-staging');
  fs.mkdirSync(publicStaging, { mode: 0o755 });
  assert.throws(() => importColdVolumeToCas({
    ...unsafe,
    execute: true,
    mountAvailableOverride: true,
    stagingRoot: publicStaging,
  }), /cold_volume_cas_import_staging_unsafe/u);
  assert.equal(fs.existsSync(path.join(unsafe.casRoot, 'objects')), false);
});

test('a process-held import lease serializes default CAS staging', async (t) => {
  const selected = fixture(t);
  fs.mkdirSync(selected.casRoot, { mode: 0o755 });
  const stagingModule = new URL(
    '../../paper-adapters/archives/cold-volume-cas-import-staging.mjs', import.meta.url,
  ).href;
  const pathBoundaryModule = new URL(
    '../../paper-adapters/archives/cold-volume-cas-path-boundary.mjs', import.meta.url,
  ).href;
  const holderSource = `
    import {
      acquireColdVolumeCasImportLease,
      openColdVolumeCasImportStaging,
      releaseColdVolumeCasImportLease,
    } from ${JSON.stringify(stagingModule)};
    import {
      closePinnedCasDirectoryChain,
      openPinnedCasAbsoluteDirectoryChain,
    } from ${JSON.stringify(pathBoundaryModule)};
    const casRootChain = openPinnedCasAbsoluteDirectoryChain(
      process.env.HEPTA_TEST_CAS_ROOT,
      { errorCode: 'cold_volume_cas_import_root_unsafe' },
    );
    const staging = openColdVolumeCasImportStaging({ casRootChain, stagingRoot: null });
    const lease = acquireColdVolumeCasImportLease(staging.directory);
    try {
      process.stdout.write('lease-ready\\n');
      await new Promise((resolve) => process.stdin.once('data', resolve));
    } finally {
      releaseColdVolumeCasImportLease(lease);
      closePinnedCasDirectoryChain(staging.closeChain);
      closePinnedCasDirectoryChain(casRootChain);
    }
  `;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderSource], {
    env: { ...process.env, HEPTA_TEST_CAS_ROOT: selected.casRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (holder.exitCode === null) holder.kill('SIGKILL'); });
  let stderr = '';
  holder.stderr.setEncoding('utf8');
  holder.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => holder.once('exit', (code, signal) => {
    resolve({ code, signal });
  }));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('import_lease_holder_timeout')), 5000);
    let output = '';
    holder.stdout.setEncoding('utf8');
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('lease-ready\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    holder.once('exit', (code) => {
      clearTimeout(timeout);
      if (!output.includes('lease-ready\n')) {
        reject(new Error(`import_lease_holder_failed:${code}:${stderr}`));
      }
    });
  });

  assert.throws(() => importColdVolumeToCas({
    ...selected, execute: true, mountAvailableOverride: true,
  }), /cold_volume_cas_import_lease_unavailable/u);
  assert.deepEqual(fs.readdirSync(path.join(selected.casRoot, '.staging')), [
    '.cold-volume-cas-import.lock',
  ]);
  holder.stdin.end('release\n');
  const outcome = await exited;
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
  assert.deepEqual(fs.readdirSync(path.join(selected.casRoot, '.staging')), []);

  const imported = importColdVolumeToCas({
    ...selected, execute: true, mountAvailableOverride: true,
  });
  assert.equal(imported.status, 'cold_volume_cas_imported');
});

test('pre-existing regular or symlink import leases fail closed without removal', (t) => {
  for (const kind of ['regular', 'symlink']) {
    const selected = fixture(t);
    const stagingRoot = path.join(selected.root, `explicit-staging-${kind}`);
    const leasePath = path.join(stagingRoot, '.cold-volume-cas-import.lock');
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
    if (kind === 'regular') {
      fs.writeFileSync(leasePath, 'operator-owned lease\n', { mode: 0o600 });
      fs.chmodSync(leasePath, 0o600);
    } else {
      const target = path.join(selected.root, 'operator-owned-lease-target');
      fs.writeFileSync(target, 'do not follow\n');
      fs.symlinkSync(target, leasePath);
    }
    const before = fs.lstatSync(leasePath, { bigint: true });
    assert.throws(() => importColdVolumeToCas({
      ...selected,
      execute: true,
      mountAvailableOverride: true,
      stagingRoot,
    }), /cold_volume_cas_import_lease_unavailable/u);
    const after = fs.lstatSync(leasePath, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.isSymbolicLink(), kind === 'symlink');
    if (kind === 'regular') {
      assert.equal(fs.readFileSync(leasePath, 'utf8'), 'operator-owned lease\n');
    }
    assert.deepEqual(fs.readdirSync(stagingRoot), ['.cold-volume-cas-import.lock']);
  }
});

test('source publication streams fixed buffers and preserves an existing object', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-stream-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'large-source.tar.gz');
  const sourceDescriptor = fs.openSync(source, 'w');
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  try {
    for (let index = 0; index < 20; index += 1) {
      fs.writeSync(sourceDescriptor, chunk, 0, chunk.length, index * chunk.length);
    }
    fs.fsyncSync(sourceDescriptor);
  } finally { fs.closeSync(sourceDescriptor); }
  const expectedHash = sha256FileSync(source);
  const token = expectedHash.slice('sha256:'.length);
  const objectName = `${token}.tar.gz`;
  const casRoot = path.join(root, 'cas');
  const casRootChain = openPinnedCasAbsoluteDirectoryChain(casRoot, { create: true });
  const objectsDirectory = openPinnedCasChildDirectory(casRootChain.at(-1), 'objects', {
    create: true,
  });
  const shardDirectory = openPinnedCasChildDirectory(objectsDirectory, token.slice(0, 2), {
    create: true,
  });
  const objectChain = Object.freeze([...casRootChain, objectsDirectory, shardDirectory]);
  const sourceIdentity = fs.statSync(source, { bigint: true });
  const originalReadFileSync = fs.readFileSync;
  const originalReadSync = fs.readSync;
  const sourceReads = [];
  fs.readFileSync = function rejectWholeSourceRead(candidate, ...arguments_) {
    if (Number.isInteger(candidate)) {
      const stat = fs.fstatSync(candidate, { bigint: true });
      if (stat.dev === sourceIdentity.dev && stat.ino === sourceIdentity.ino) {
        throw new Error('whole_source_read_forbidden');
      }
    }
    return originalReadFileSync.call(this, candidate, ...arguments_);
  };
  fs.readSync = function observeSourceRead(descriptor, buffer, offset, length, ...arguments_) {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (stat.dev === sourceIdentity.dev && stat.ino === sourceIdentity.ino) {
      sourceReads.push(length);
    }
    return originalReadSync.call(this, descriptor, buffer, offset, length, ...arguments_);
  };
  try {
    publishPinnedCasSourceFile(
      objectChain, objectName, source, expectedHash, 'stream_publication_failed',
    );
    assert.ok(sourceReads.length >= 3);
    assert.ok(Math.max(...sourceReads) <= 8 * 1024 * 1024);
    const object = path.join(casRoot, 'objects', token.slice(0, 2), objectName);
    const first = fs.statSync(object, { bigint: true });
    assert.equal(first.mode & 0o7777n, 0o444n);
    assert.equal(first.nlink, 1n);
    assert.equal(sha256FileSync(object), expectedHash);

    sourceReads.length = 0;
    publishPinnedCasSourceFile(
      objectChain, objectName, source, expectedHash, 'stream_publication_failed',
    );
    const second = fs.statSync(object, { bigint: true });
    assert.equal(second.dev, first.dev);
    assert.equal(second.ino, first.ino);
    assert.equal(second.nlink, 1n);
    assert.ok(sourceReads.length >= 5);
    assert.ok(Math.max(...sourceReads) <= 4 * 1024 * 1024);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.readSync = originalReadSync;
    closePinnedCasDirectoryChain([shardDirectory]);
    closePinnedCasDirectoryChain([objectsDirectory]);
    closePinnedCasDirectoryChain(casRootChain);
  }
});

test('stream publication rejects source path replacement and removes target staging', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-stream-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.tar.gz');
  fs.writeFileSync(source, Buffer.alloc(12 * 1024 * 1024, 0x31));
  const expectedHash = sha256FileSync(source);
  const token = expectedHash.slice('sha256:'.length);
  const casRoot = path.join(root, 'cas');
  const casRootChain = openPinnedCasAbsoluteDirectoryChain(casRoot, { create: true });
  const objectsDirectory = openPinnedCasChildDirectory(casRootChain.at(-1), 'objects', {
    create: true,
  });
  const shardDirectory = openPinnedCasChildDirectory(objectsDirectory, token.slice(0, 2), {
    create: true,
  });
  const objectChain = Object.freeze([...casRootChain, objectsDirectory, shardDirectory]);
  const sourceIdentity = fs.statSync(source, { bigint: true });
  const originalReadSync = fs.readSync;
  let replaced = false;
  fs.readSync = function replaceSourceAfterFirstRead(
    descriptor, buffer, offset, length, ...arguments_
  ) {
    const bytesRead = originalReadSync.call(
      this, descriptor, buffer, offset, length, ...arguments_,
    );
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!replaced && bytesRead > 0
      && stat.dev === sourceIdentity.dev && stat.ino === sourceIdentity.ino) {
      replaced = true;
      fs.renameSync(source, path.join(root, 'relocated-source.tar.gz'));
      fs.writeFileSync(source, Buffer.alloc(12 * 1024 * 1024, 0x32));
    }
    return bytesRead;
  };
  try {
    assert.throws(() => publishPinnedCasSourceFile(
      objectChain,
      `${token}.tar.gz`,
      source,
      expectedHash,
      'stream_publication_source_changed',
    ), /stream_publication_source_changed/u);
    assert.equal(replaced, true);
    assert.deepEqual(fs.readdirSync(path.join(casRoot, 'objects', token.slice(0, 2))), []);
  } finally {
    fs.readSync = originalReadSync;
    closePinnedCasDirectoryChain([shardDirectory]);
    closePinnedCasDirectoryChain([objectsDirectory]);
    closePinnedCasDirectoryChain(casRootChain);
  }
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
  const selectedObject = fs.lstatSync(path.join(shard, `${token}.tar.gz`), { bigint: true });
  const originalReadSync = fs.readSync;
  let replaced = false;
  fs.readSync = function replaceShardAfterFirstRead(...arguments_) {
    const bytesRead = originalReadSync.apply(this, arguments_);
    const opened = fs.fstatSync(arguments_[0], { bigint: true });
    if (!replaced && bytesRead > 0 && opened.dev === selectedObject.dev
      && opened.ino === selectedObject.ino) {
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
  assert.deepEqual(fs.readdirSync(path.join(casRoot, '.staging')), []);
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
  assert.deepEqual(fs.readdirSync(path.join(casRoot, '.staging')), []);
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

test('cold-volume CAS CLI rejects a root outside the contract', (t) => {
  const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-gate-test-'));
  t.after(() => fs.rmSync(casRoot, { recursive: true, force: true }));
  const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const env = { ...process.env, HEPTA_COLD_OBJECT_STORE_ROOT: casRoot };
  const status = spawnSync(process.execPath, ['paper-core/bin/cold-volume-cas.mjs', 'status'], {
    cwd, env, encoding: 'utf8',
  });
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /cold_volume_cas_root_contract_mismatch/u);
  assert.equal(status.stdout, '');
  assert.deepEqual(fs.readdirSync(casRoot), []);
});
