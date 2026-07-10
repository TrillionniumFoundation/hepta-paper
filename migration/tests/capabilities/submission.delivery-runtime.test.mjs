import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteReceiptLedger } from '../../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import { fixedClock, temporaryDirectory, temporaryStore } from './test-support.mjs';

test('submission.delivery-runtime recovers after restart, deduplicates responses and dead-letters retries', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  let delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  const authorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: 'h', provider: 'provider', accountId: 'account', nonce: 'nonce' };
  const message = delivery.enqueue({ paperId: 'p', dispatchAuthorization: authorization, payload: {} });
  assert.equal(delivery.recoverPending().length, 1);
  delivery.recordResponse({ messageId: message.message_id, response: { responseId: 'r', outcome: 'failed', dispatchAuthorizationHash: 'h' } });
  delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  assert.equal(delivery.recoverPending().length, 1);
  delivery.recordResponse({ messageId: message.message_id, response: { responseId: 'r', outcome: 'failed', dispatchAuthorizationHash: 'h' } });
  assert.throws(() => delivery.recordResponse({ messageId: message.message_id, response: { responseId: 'r', outcome: 'cancelled', dispatchAuthorizationHash: 'h' } }), /duplicate executor response conflict/);
  assert.equal(delivery.scheduleRedrive({ messageId: message.message_id, maximumAttempts: 1 }).status, 'submission_dead_letter_recorded');
});

test('submission.delivery-runtime verifies provider receipts and serializes release locks', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  const authorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: 'h2', provider: 'provider', accountId: 'account', nonce: 'nonce-2' };
  const message = delivery.enqueue({ paperId: 'p2', dispatchAuthorization: authorization, payload: {} });
  const lock = delivery.acquireReleaseLock({ paperId: 'p2', messageId: message.message_id, lockToken: 'lock-2' });
  assert.equal(delivery.acquireReleaseLock({ paperId: 'p2', messageId: message.message_id, lockToken: 'competing-lock' }), null);
  const providerReceipt = { provider: 'provider', accountId: 'account', submissionId: 'external-1' };
  const providerReceiptHash = hashRecord('ProviderSubmissionReceipt', providerReceipt);
  assert.throws(() => delivery.recordResponse({ messageId: message.message_id, response: { responseId: 'bad', outcome: 'submitted', dispatchAuthorizationHash: 'h2', providerReceipt, providerReceiptHash: 'sha256:bad' } }), /provider receipt hash mismatch/);
  delivery.recordResponse({ messageId: message.message_id, response: { responseId: 'r2', outcome: 'submitted', dispatchAuthorizationHash: 'h2', providerReceipt, providerReceiptHash } });
  assert.throws(() => delivery.release({ paperId: 'p2', lockToken: lock.lock_token, releaseLock: { status: 'submission_release_locked' } }));
  const released = delivery.release({ paperId: 'p2', lockToken: lock.lock_token, releaseLock: { status: 'submission_release_unlocked', reconciliationHash: 'sha256:reconciliation' } });
  assert.equal(released.status, 'released');
  assert.throws(() => delivery.release({ paperId: 'p2', lockToken: lock.lock_token, releaseLock: { status: 'submission_release_unlocked', reconciliationHash: 'sha256:reconciliation' } }), /active release lock missing/);
});
