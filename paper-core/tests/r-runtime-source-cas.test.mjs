import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPositSnapshotRSourceArchiveTransport } from '../../paper-adapters/automation/r-runtime-source-archive-transport.mjs';
import { createRRuntimeSourceCasRepository } from '../../paper-adapters/automation/r-runtime-source-cas-repository.mjs';
import {
  acquireRRuntimeSourceCas,
  verifyRRuntimeSourceCas,
} from '../../paper-adapters/automation/r-runtime-source-cas.mjs';
import { R_RUNTIME_SOURCE_CAS } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE_CONTEXT = path.join(REPOSITORY_ROOT, 'runtime-images', 'r-scientific');

function onePackageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-r-source-cas-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contextPath = path.join(root, 'context');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(contextPath);
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(contextPath, 'renv.lock'), `${JSON.stringify({
    R: { Version: '4.4.2' },
    Packages: {
      askpass: {
        Package: 'askpass',
        Version: '1.2.1',
        Source: 'Repository',
        Repository: 'CRAN',
      },
    },
  }, null, 2)}\n`);
  fs.copyFileSync(
    path.join(SOURCE_CONTEXT, 'source-cas', 'src', 'contrib', 'askpass_1.2.1.tar.gz'),
    path.join(seed, 'askpass_1.2.1.tar.gz'),
  );
  return { contextPath, seed };
}

test('checked-in R source CAS is the exact 104-package lock closure', () => {
  const current = verifyRRuntimeSourceCas({ contextPath: SOURCE_CONTEXT });
  assert.equal(current.ready, true, JSON.stringify(current.blockers));
  assert.equal(current.packageCount, 104);
  assert.equal(current.manifestHash, R_RUNTIME_SOURCE_CAS.manifestHash);
  assert.equal(current.definitionPaths.length, 107);
});

test('seed acquisition is atomic, offline, content-hashed and fail-closed on manifest tamper', async (t) => {
  const fixture = onePackageFixture(t);
  let networkCalled = false;
  const archiveTransport = Object.freeze({
    version: 1,
    kind: 'RRuntimeSourceArchiveTransport',
    async fetchArchive() { networkCalled = true; throw new Error('network_forbidden'); },
  });
  const acquired = await acquireRRuntimeSourceCas({
    contextPath: fixture.contextPath,
    seedSourceDirectory: fixture.seed,
    concurrency: 1,
    archiveTransport,
    repository: createRRuntimeSourceCasRepository({ contextPath: fixture.contextPath }),
  });
  assert.equal(acquired.ready, true, JSON.stringify(acquired.blockers));
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.packageCount, 1);
  assert.equal(networkCalled, false);

  const manifestPath = path.join(fixture.contextPath, 'source-cas', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.packages[0].unexpected = 'fully-rehashed-attacker-field';
  const { rRuntimeSourceCasManifestHash: _oldHash, ...payload } = manifest;
  manifest.rRuntimeSourceCasManifestHash = hashRecord('RRuntimeSourceCasManifest', payload);
  fs.chmodSync(manifestPath, 0o644);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const tampered = verifyRRuntimeSourceCas({ contextPath: fixture.contextPath });
  assert.equal(tampered.ready, false);
  assert.ok(tampered.blockers.includes('r_runtime_source_cas_manifest_drift'));
});

test('lock map-key drift is rejected and snapshot transport is URL- and size-bounded', async (t) => {
  const fixture = onePackageFixture(t);
  const lockPath = path.join(fixture.contextPath, 'renv.lock');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.Packages.attacker = lock.Packages.askpass;
  delete lock.Packages.askpass;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const inspection = verifyRRuntimeSourceCas({ contextPath: fixture.contextPath });
  assert.equal(inspection.ready, false);
  assert.match(inspection.blockers[0], /r_runtime_source_cas_lock_entry_invalid/);

  let called = false;
  const transport = createPositSnapshotRSourceArchiveTransport({
    maximumArchiveBytes: 100,
    fetchImpl: async () => {
      called = true;
      return {
        ok: true,
        status: 200,
        url: 'https://packagemanager.posit.co/cran/2024-11-01/src/contrib/askpass_1.2.1.tar.gz',
        headers: { get: () => '101' },
        arrayBuffer: async () => new Uint8Array(101).buffer,
      };
    },
  });
  await assert.rejects(() => transport.fetchArchive({ url: 'https://attacker.invalid/a.tar.gz' }),
    /r_source_archive_url_outside_fixed_snapshot/);
  assert.equal(called, false);
  await assert.rejects(() => transport.fetchArchive({
    url: 'https://packagemanager.posit.co/cran/2024-11-01/src/contrib/askpass_1.2.1.tar.gz',
  }), /r_source_archive_declared_size_exceeded/);
});
