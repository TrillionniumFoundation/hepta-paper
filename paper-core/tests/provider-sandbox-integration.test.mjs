import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { runProviderSandboxQuarantineProbe } from './support/provider-sandbox-quarantine-probe.mjs';

// Deliberately no fixture fallback or skip: the real companion remains required.
const companionEntry = fileURLToPath(new URL(
  '../../../hepta-paper-provider-sandbox/provider-sandbox.mjs', import.meta.url,
));
test('external provider sandbox incomplete response is quarantined', () => {
  const payload = { version: 1, kind: 'SubmissionDispatchAuthorization',
    status: 'submission_dispatch_authorization_ready', paperId: 'real-paper-sandbox-fixture',
    provider: 'sandbox-provider', accountId: 'sandbox-account', nonce: `sandbox-${process.pid}` };
  const result = runProviderSandboxQuarantineProbe({
    companionEntry, createStore: createDefaultPaperStore,
    createReceiptLedger: createSqliteReceiptLedger,
    createDeliveryStore: createSqliteSubmissionDeliveryStore, clock: createSystemClock(),
    dispatchAuthorization: { ...payload,
      submissionDispatchAuthorizationHash: hashRecord('SubmissionDispatchAuthorization', payload) },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
