import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFilesystemArtifactRepository } from '../../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { temporaryDirectory } from './test-support.mjs';

test('runtime.artifact-repository performs scoped atomic writes and persists receipt', async (t) => {
  const root = await temporaryDirectory(t);
  const receipts = [];
  const repository = createFilesystemArtifactRepository({ scopeRoot: root, receiptLedger: { record: (receipt) => receipts.push(receipt) } });
  const receipt = await repository.writeJson(path.join(root, 'a.json'), { ok: true }, { role: 'test', atomic: true });
  assert.equal(receipt.atomic, true);
  assert.equal(receipts.length, 1);
  await assert.rejects(repository.writeText(path.join(root, '..', 'escape'), 'x'));
});
