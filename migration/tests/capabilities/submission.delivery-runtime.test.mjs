import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteReceiptLedger } from '../../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { fixedClock, temporaryDirectory, temporaryStore } from './test-support.mjs';

test('submission.delivery-runtime persists outbox inbox redrive and dead letter state', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  const authorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: 'h', provider: 'provider', accountId: 'account', nonce: 'nonce' };
  const message = delivery.enqueue({ paperId: 'p', dispatchAuthorization: authorization, payload: {} });
  delivery.recordResponse({ messageId: message.message_id, response: { responseId: 'r', outcome: 'failed', dispatchAuthorizationHash: 'h' } });
  assert.equal(delivery.scheduleRedrive({ messageId: message.message_id, maximumAttempts: 1 }).status, 'submission_dead_letter_recorded');

  const acceptedAuthorization = { ...authorization, submissionDispatchAuthorizationHash: 'h2', nonce: 'nonce-2' };
  const acceptedMessage = delivery.enqueue({ paperId: 'p2', dispatchAuthorization: acceptedAuthorization, payload: {} });
  const lock = delivery.acquireReleaseLock({ paperId: 'p2', messageId: acceptedMessage.message_id, lockToken: 'lock-2' });
  delivery.recordResponse({ messageId: acceptedMessage.message_id, response: { responseId: 'r2', outcome: 'submitted', dispatchAuthorizationHash: 'h2', providerReceiptHash: 'sha256:provider' } });
  assert.throws(() => delivery.release({ paperId: 'p2', lockToken: lock.lock_token, releaseLock: { status: 'submission_release_locked' } }));
  const released = delivery.release({ paperId: 'p2', lockToken: lock.lock_token, releaseLock: { status: 'submission_release_unlocked', reconciliationHash: 'sha256:reconciliation' } });
  assert.equal(released.status, 'released');
});
