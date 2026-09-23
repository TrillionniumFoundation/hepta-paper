import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAutonomousSubmissionOutboxRepository,
} from '../../paper-adapters/automation/autonomous-submission-outbox-repository.mjs';
import {
  createDefaultPaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import {
  createSqliteReceiptLedger,
} from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  createSqliteSubmissionDeliveryStore,
} from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';

const NOW = '2026-07-21T04:00:00.000Z';
const clock = Object.freeze({
  now: () => new Date(NOW),
  nowIso: () => NOW,
});

function roots(t, prefix) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'assets');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  return { root, runtimeRoot };
}

function autonomousEnvelope({ suffix = 'one', paperId = 'paper-shared' } = {}) {
  const idempotencyKey = `sha256:${suffix.padEnd(64, '0').slice(0, 64)}`;
  const requestHash = `sha256:${suffix.padEnd(64, '1').slice(0, 64)}`;
  const portalConfigurationHash = `sha256:${suffix.padEnd(64, '2').slice(0, 64)}`;
  const messageId = `autonomous-submission:${idempotencyKey}`;
  return Object.freeze({
    row: Object.freeze({
      messageId,
      paperId,
      dispatchHash: requestHash,
      provider: 'portal-one',
      accountId: portalConfigurationHash,
      nonce: idempotencyKey,
    }),
    payload: Object.freeze({
      version: 1,
      kind: 'AutonomousSubmissionOutboxEnvelope',
      request: Object.freeze({
        paperId,
        requestHash,
        portalConfigurationHash,
        idempotencyKey,
      }),
      portalId: 'portal-one',
      stateReceipt: Object.freeze({ messageId, portalId: 'portal-one' }),
    }),
  });
}

function insertLegacyRow(store, {
  messageId,
  paperId = 'paper-shared',
  dispatchHash,
  provider = 'reviewed-provider',
  accountId = 'reviewed-account',
  nonce,
  payload,
} = {}) {
  const result = store.execute(`INSERT INTO submission_outbox(
    message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,
    payload_json,next_attempt_at,created_at,updated_at
  ) VALUES(
    ${sqlText(messageId)},${sqlText(paperId)},${sqlText(dispatchHash)},
    ${sqlText(provider)},${sqlText(accountId)},${sqlText(nonce)},'pending',0,
    ${sqlJson(payload)},${sqlText(NOW)},${sqlText(NOW)},${sqlText(NOW)}
  );`);
  assert.equal(result.ok, true, result.error);
}

function insertKindedRow(store, deliveryKind, row, payload) {
  return store.execute(`INSERT INTO submission_outbox(
    delivery_kind,message_id,paper_id,dispatch_hash,provider,account_id,nonce,
    status,attempt_count,payload_json,next_attempt_at,created_at,updated_at
  ) VALUES(
    ${sqlText(deliveryKind)},${sqlText(row.messageId)},${sqlText(row.paperId)},
    ${sqlText(row.dispatchHash)},${sqlText(row.provider)},${sqlText(row.accountId)},
    ${sqlText(row.nonce)},'pending',0,${sqlJson(payload)},${sqlText(NOW)},
    ${sqlText(NOW)},${sqlText(NOW)}
  );`);
}

test('migration classifies recognizable rows and quarantines ambiguous autonomous claims', (t) => {
  const workspace = roots(t, 'hepta-submission-kind-migration-');
  const store23 = createDefaultPaperStore({ ...workspace, targetVersion: 23 });
  const autonomous = autonomousEnvelope({ suffix: 'a' });
  insertLegacyRow(store23, { ...autonomous.row, payload: autonomous.payload });
  insertLegacyRow(store23, {
    messageId: 'submission:reviewed-one',
    dispatchHash: 'reviewed-dispatch-one',
    nonce: 'reviewed-nonce-one',
    payload: { reviewed: true },
  });
  insertLegacyRow(store23, {
    messageId: 'autonomous-submission:malformed',
    dispatchHash: 'malformed-dispatch',
    nonce: 'malformed-nonce',
    payload: { kind: 'AutonomousSubmissionOutboxEnvelope' },
  });
  store23.close();

  const store24 = createDefaultPaperStore({ ...workspace, targetVersion: 24 });
  t.after(() => store24.close());
  const rows = store24.query(`SELECT message_id,delivery_kind FROM submission_outbox
    ORDER BY message_id;`).rows;
  assert.deepEqual(rows, [
    { message_id: 'autonomous-submission:malformed', delivery_kind: 'quarantined_legacy' },
    { message_id: autonomous.row.messageId, delivery_kind: 'autonomous' },
    { message_id: 'submission:reviewed-one', delivery_kind: 'reviewed' },
  ]);
  assert.equal(store24.query(`SELECT value FROM store_metadata
    WHERE key='submission_outbox_quarantined_legacy_count';`).rows[0].value, '1');

  const oldWriter = store24.execute(`INSERT INTO submission_outbox(
    message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,
    payload_json,created_at,updated_at
  ) VALUES('submission:old-writer','paper','old-dispatch','provider','account',
    'old-nonce','pending','{}',${sqlText(NOW)},${sqlText(NOW)});`);
  assert.equal(oldWriter.ok, false);
  assert.match(oldWriter.error, /submission_outbox_delivery_kind_required/);

  const forgedReviewed = insertKindedRow(store24, 'reviewed', {
    ...autonomousEnvelope({ suffix: 'b' }).row,
  }, autonomousEnvelope({ suffix: 'b' }).payload);
  assert.equal(forgedReviewed.ok, false);
  assert.match(forgedReviewed.error, /submission_outbox_reviewed_binding_invalid/);

  const malformedAutonomous = insertKindedRow(store24, 'autonomous', {
    messageId: 'autonomous-submission:bad-new',
    paperId: 'paper-shared',
    dispatchHash: 'bad-new-dispatch',
    provider: 'portal-one',
    accountId: 'bad-new-account',
    nonce: 'bad-new-nonce',
  }, { kind: 'AutonomousSubmissionOutboxEnvelope' });
  assert.equal(malformedAutonomous.ok, false);
  assert.match(malformedAutonomous.error, /submission_outbox_autonomous_binding_invalid/);

  const reclassification = store24.execute(`UPDATE submission_outbox
    SET delivery_kind='reviewed'
    WHERE message_id=${sqlText(autonomous.row.messageId)};`);
  assert.equal(reclassification.ok, false);
  assert.match(reclassification.error, /submission_outbox_delivery_kind_immutable/);
});

test('reviewed and autonomous repositories filter delivery kind before parsing rows', (t) => {
  const workspace = roots(t, 'hepta-submission-kind-runtime-');
  const store = createDefaultPaperStore({ ...workspace, targetVersion: 24 });
  t.after(() => store.close());
  const reviewed = {
    messageId: 'submission:reviewed-cross-stack',
    paperId: 'paper-shared',
    dispatchHash: 'reviewed-cross-stack-dispatch',
    provider: 'reviewed-provider',
    accountId: 'reviewed-account',
    nonce: 'reviewed-cross-stack-nonce',
  };
  assert.equal(insertKindedRow(store, 'reviewed', reviewed, { reviewed: true }).ok, true);

  const receiptLedger = createSqliteReceiptLedger({ store, clock });
  const autonomousRepository = createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger,
    clock,
    submissionRequestVerifier: Object.freeze({
      version: 1,
      kind: 'AutonomousSubmissionRequestVerifier',
      verify: () => true,
    }),
    handoffOnly: true,
  });
  assert.deepEqual(autonomousRepository.listAutonomousSubmissionsForCampaign({
    campaignId: 'campaign-one',
    paperId: reviewed.paperId,
  }), []);

  const autonomous = autonomousEnvelope({ suffix: 'c' });
  assert.equal(insertKindedRow(
    store, 'autonomous', autonomous.row, autonomous.payload,
  ).ok, true);
  const reviewedStore = createSqliteSubmissionDeliveryStore({
    store,
    receiptLedger,
    clock,
  });
  assert.equal(reviewedStore.getOutbox(autonomous.row.messageId), null);
  assert.deepEqual(
    reviewedStore.listOutbox().map((row) => row.message_id),
    [reviewed.messageId],
  );
});
