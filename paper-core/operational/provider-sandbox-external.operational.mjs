import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { runProviderSandboxQuarantineProbe } from '../tests/support/provider-sandbox-quarantine-probe.mjs';

// This gate deliberately has no fixture fallback and no missing-source skip.
// It is not part of the portable source-test glob; release/qualification
// orchestration must execute it explicitly on a provisioned external subject.
const companionEntry = fileURLToPath(new URL(
  '../../../hepta-paper-provider-sandbox/provider-sandbox.mjs', import.meta.url,
));

test('external provider sandbox incomplete response is quarantined', () => {
  const payload = { version: 1, kind: 'SubmissionDispatchAuthorization',
    status: 'submission_dispatch_authorization_ready', paperId: 'external-provider-operational',
    provider: 'sandbox-provider', accountId: 'sandbox-account', nonce: `external-${process.pid}` };
  const result = runProviderSandboxQuarantineProbe({
    companionEntry, createStore: createDefaultPaperStore,
    createReceiptLedger: createSqliteReceiptLedger,
    createDeliveryStore: createSqliteSubmissionDeliveryStore, clock: createSystemClock(),
    dispatchAuthorization: { ...payload,
      submissionDispatchAuthorizationHash: hashRecord('SubmissionDispatchAuthorization', payload) },
  });
  process.stdout.write(`${JSON.stringify({ ...result,
    evidenceClass: 'external_companion_operational',
    productionAuthorized: false,
  })}\n`);
});
