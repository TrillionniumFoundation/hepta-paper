import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFilesystemArtifactRepository } from '../../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { temporaryDirectory } from './test-support.mjs';

test('runtime.artifact-repository performs scoped atomic writes and persists receipt', async (t) => {
  const root = await temporaryDirectory(t);
  const receipts = [];
  const repository = createFilesystemArtifactRepository({
    scopeRoot: root,
    casRoot: path.join(root, 'cas'),
    clock: {
      now: () => new Date('2026-07-10T00:00:00.000Z'),
      nowIso: () => '2026-07-10T00:00:00.000Z',
    },
    receiptLedger: { record: (receipt) => { receipts.push(receipt); return { receiptId: `r:${receipts.length}` }; } },
  });
  const receipt = await repository.writeJson(path.join(root, 'a.json'), { ok: true }, { role: 'test', atomic: true });
  assert.equal(receipt.atomic, true);
  assert.equal(receipt.immutableObject, true);
  assert.ok(receipt.manifestHash);
  assert.equal((await repository.readManifest(receipt.manifestHash)).contentHash, receipt.hash);
  assert.equal(receipts.length, 1);
  assert.equal((await repository.garbageCollect({ dryRun: true })).status, 'artifact_gc_dry_run_recorded');
  await assert.rejects(repository.writeText(path.join(root, '..', 'escape'), 'x'));
});
