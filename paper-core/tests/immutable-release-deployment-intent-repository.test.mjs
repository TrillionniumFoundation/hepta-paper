import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createImmutableReleaseDeploymentIntentRepository,
  IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_FILE,
} from '../../paper-adapters/runtime/immutable-release-deployment-intent-repository.mjs';
import {
  immutableReleaseDeploymentPlanFixture,
  immutableReleaseHostSnapshotFixture,
} from './support/immutable-release-deployment-fixture.mjs';
import {
  assertImmutableReleaseHostSnapshot,
  IMMUTABLE_RELEASE_HOST_SNAPSHOT_MAXIMUM_BYTES,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-intent-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    root,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowUnpinnedRoot: true,
  };
  return { root, options, plan: immutableReleaseDeploymentPlanFixture() };
}

test('intent journal persists every marker atomically and reopens after process boundaries', (t) => {
  const sample = fixture(t);
  let repository = createImmutableReleaseDeploymentIntentRepository(sample.options);
  let intent = repository.begin({ plan: sample.plan });
  assert.equal(intent.phase, 'prepared');
  repository = createImmutableReleaseDeploymentIntentRepository(sample.options);
  assert.deepEqual(repository.read(), intent);

  for (const phase of ['materialize_attempted', 'materialized']) {
    intent = repository.advance({ expectedIntentHash: intent.intentHash, phase });
    repository = createImmutableReleaseDeploymentIntentRepository(sample.options);
    assert.deepEqual(repository.read(), intent);
  }
  intent = repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'closure_verified',
    progress: { closureHash: `sha256:${'1'.repeat(64)}` },
  });
  intent = repository.advance({ expectedIntentHash: intent.intentHash, phase: 'publish_attempted' });
  intent = repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'published',
    progress: { publicationIdentityHash: `sha256:${'2'.repeat(64)}` },
  });
  const snapshot = immutableReleaseHostSnapshotFixture(sample.plan);
  intent = repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'snapshot_persisted',
    hostSnapshot: snapshot,
  });
  assert.deepEqual(repository.read().hostSnapshot, snapshot);
  intent = repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'rollback_attempted',
  });
  intent = repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'rollback_verified',
  });
  assert.equal(repository.remove({ expectedIntentHash: intent.intentHash }), true);
  assert.equal(repository.read(), null);
});

test('journal rejects skipped phases, stale writers, unsafe metadata and byte tampering', (t) => {
  const sample = fixture(t);
  const repository = createImmutableReleaseDeploymentIntentRepository(sample.options);
  const intent = repository.begin({ plan: sample.plan });
  assert.throws(() => repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'materialized',
  }), /immutable_release_deployment_intent_transition_invalid/u);
  assert.throws(() => repository.advance({
    expectedIntentHash: `sha256:${'0'.repeat(64)}`,
    phase: 'materialize_attempted',
  }), /immutable_release_deployment_intent_conflict/u);
  const file = path.join(sample.root, IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_FILE);
  fs.chmodSync(file, 0o644);
  assert.throws(() => repository.read(),
    /immutable_release_deployment_intent_file_invalid/u);
  fs.chmodSync(file, 0o600);
  fs.appendFileSync(file, ' ');
  assert.throws(() => repository.read(),
    /immutable_release_deployment_intent_(?:noncanonical|file_invalid)/u);
});

test('oversized aggregate snapshot is rejected before replacing the recoverable intent', (t) => {
  const sample = fixture(t);
  const repository = createImmutableReleaseDeploymentIntentRepository(sample.options);
  let intent = repository.begin({ plan: sample.plan });
  for (const phase of ['materialize_attempted', 'materialized']) {
    intent = repository.advance({ expectedIntentHash: intent.intentHash, phase });
  }
  intent = repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'closure_verified',
    progress: { closureHash: `sha256:${'1'.repeat(64)}` },
  });
  intent = repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'publish_attempted',
  });
  intent = repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'published',
    progress: { publicationIdentityHash: `sha256:${'2'.repeat(64)}` },
  });

  const original = immutableReleaseHostSnapshotFixture(sample.plan);
  const content = Buffer.alloc(Math.floor(
    (IMMUTABLE_RELEASE_HOST_SNAPSHOT_MAXIMUM_BYTES * 3) / 4,
  ) + 1, 0x61);
  const artifactBackups = original.artifactBackups.map((backup, index) => index === 0
    ? Object.freeze({
      ...backup,
      contentBase64: content.toString('base64'),
      contentHash: hashBytes(content),
    })
    : backup);
  const payload = {
    version: original.version,
    kind: original.kind,
    status: original.status,
    configIdentityHash: original.configIdentityHash,
    mountIdentityHash: original.mountIdentityHash,
    recoveryGateIdentityHash: original.recoveryGateIdentityHash,
    unitStates: original.unitStates,
    artifactBackups,
  };
  const oversized = {
    ...payload,
    hostSnapshotHash: hashRecord('ImmutableReleaseHostSnapshot', payload),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized))
    > IMMUTABLE_RELEASE_HOST_SNAPSHOT_MAXIMUM_BYTES);
  assert.throws(() => assertImmutableReleaseHostSnapshot(oversized),
    /immutable_release_deployment_host_snapshot_invalid/u);
  assert.throws(() => repository.advance({
    expectedIntentHash: intent.intentHash,
    phase: 'snapshot_persisted',
    hostSnapshot: oversized,
  }), /immutable_release_deployment_intent_snapshot_invalid/u);
  assert.equal(repository.read().intentHash, intent.intentHash);
  assert.equal(repository.read().phase, 'published');
});
