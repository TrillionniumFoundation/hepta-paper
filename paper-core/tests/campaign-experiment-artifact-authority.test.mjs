import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { verifyArtifactWriteReceiptSource } from '../../paper-adapters/artifacts/artifact-write-receipt-verifier.mjs';
import {
  campaignExperimentRawArtifactRole,
  persistCampaignExperimentRawArtifact,
} from '../../paper-adapters/automation/campaign-experiment-artifact-authority.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { composeArtifactReceiptLedger } from '../../paper-composition/bootstrap/receipt-ledger-composition.mjs';
import { verifyTrustedLedgerReceipt } from '../../paper-domain/evidence/trusted-ledger-receipt.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

test('campaign raw observations are immutable CAS artifacts with attempt-scoped trusted ledger authority', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-raw-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const outputRoot = path.join(root, 'output');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  const raw = Buffer.from('{"cellId":"cell-1","metric":1}\n');
  fs.writeFileSync(path.join(outputRoot, 'raw-events.ndjson'), raw);
  const clock = {
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    nowIso: () => '2026-07-15T00:00:00.000Z',
  };
  const store = createDefaultPaperStore({ root, runtimeRoot });
  t.after(() => store.close?.());
  const artifactLedger = composeArtifactReceiptLedger({ store, clock });
  const receiptLedger = createSqliteReceiptLedger({ store, clock });
  const artifactRepositoryFactory = (scopeRoot) => createFilesystemArtifactRepository({
    scopeRoot,
    casRoot: path.join(runtimeRoot, 'artifact-cas'),
    receiptLedger: artifactLedger,
    clock,
  });
  const identity = {
    paperId: 'paper-raw-authority',
    campaignId: 'campaign:raw-authority',
    nodeId: 'campaign:raw-authority:0:empirical',
    attemptId: 'attempt-original',
  };
  const original = await persistCampaignExperimentRawArtifact({
    artifactRepositoryFactory,
    runtimeRoot,
    outputDirectory: outputRoot,
    ...identity,
    executionRole: 'original',
    expectedHash: hashBytes(raw),
    expectedBytes: raw.length,
  });
  assert.equal(original.role, campaignExperimentRawArtifactRole({ ...identity, executionRole: 'original' }));
  assert.match(original.path, /^raw-events-[0-9a-f]{64}\.ndjson$/);
  assert.equal(verifyArtifactWriteReceiptSource({ receipt: original }).status, 'artifact_write_receipt_source_verified');
  assert.equal(verifyTrustedLedgerReceipt({
    receipt: original,
    ledgerReceiptId: original.ledgerReceiptId,
    receiptLedger,
    expectedKinds: ['ArtifactWriteReceipt'],
    expectedStreams: ['artifact-writes'],
    expectedWriterKinds: ['content-addressed-repository'],
  }).status, 'trusted_ledger_receipt_verified');
  const untrustedLedger = createSqliteReceiptLedger({ store, clock });
  const { ledgerReceiptId: _trustedLedgerReceiptId, ...storedReceipt } = original;
  const untrustedRecord = untrustedLedger.record(storedReceipt, { stream: 'untrusted-artifact-writes' });
  const untrustedVerification = verifyTrustedLedgerReceipt({
    receipt: { ...original, ledgerReceiptId: untrustedRecord.receiptId },
    ledgerReceiptId: untrustedRecord.receiptId,
    receiptLedger,
    expectedKinds: ['ArtifactWriteReceipt'],
    expectedStreams: ['untrusted-artifact-writes'],
  });
  assert.equal(untrustedVerification.status, 'trusted_ledger_receipt_blocked');
  assert.ok(untrustedVerification.blockers.includes('trusted_receipt_writer_untrusted'));

  const replay = await persistCampaignExperimentRawArtifact({
    artifactRepositoryFactory,
    runtimeRoot,
    outputDirectory: outputRoot,
    ...identity,
    nodeId: 'campaign:raw-authority:0:empirical-reproduce',
    attemptId: 'attempt-replay',
    executionRole: 'independent-replay',
    expectedHash: hashBytes(raw),
    expectedBytes: raw.length,
  });
  assert.notEqual(replay.writeReceiptHash, original.writeReceiptHash);
  assert.notEqual(replay.ledgerReceiptId, original.ledgerReceiptId);
  assert.notEqual(replay.role, original.role);

  const materialized = path.join(original.scopeRoot, original.path);
  fs.chmodSync(materialized, 0o600);
  fs.writeFileSync(materialized, Buffer.from('tampered\n'));
  const tampered = verifyArtifactWriteReceiptSource({ receipt: original });
  assert.equal(tampered.status, 'artifact_write_receipt_source_blocked');
  assert.ok(tampered.blockers.includes('artifact_materialized_hash_mismatch'));
  fs.rmSync(materialized);
  const deleted = verifyArtifactWriteReceiptSource({ receipt: original });
  assert.equal(deleted.status, 'artifact_write_receipt_source_blocked');
  assert.ok(deleted.blockers.includes('artifact_materialized_file_missing'));
  await assert.rejects(() => persistCampaignExperimentRawArtifact({
    artifactRepositoryFactory,
    runtimeRoot,
    outputDirectory: outputRoot,
    ...identity,
    attemptId: '../attempt',
    executionRole: 'original',
    expectedHash: hashBytes(raw),
    expectedBytes: raw.length,
  }), /campaign_experiment_artifact_identity_invalid/);
});
