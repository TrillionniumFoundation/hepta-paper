import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { runProviderSandboxQuarantineProbe } from './support/provider-sandbox-quarantine-probe.mjs';

// The portable source suite binds the repository-owned no-effect technical
// companion. The separately invoked operational gate retains the authoritative
// sibling requirement and has no fallback or missing-source skip.
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const companionEntry = fileURLToPath(new URL(
  '../../provider-sandbox/provider-sandbox.mjs', import.meta.url,
));
const externalCompanionEntry = fileURLToPath(new URL(
  '../../../hepta-paper-provider-sandbox/provider-sandbox.mjs', import.meta.url,
));

test('portable integration resolves only the repository technical companion', () => {
  assert.equal(path.relative(repositoryRoot, companionEntry),
    'provider-sandbox/provider-sandbox.mjs');
  assert.notEqual(companionEntry, externalCompanionEntry);
  assert.equal(fs.lstatSync(companionEntry).isFile(), true);
});

test('portable technical sandbox incomplete response is quarantined', () => {
  const payload = { version: 1, kind: 'SubmissionDispatchAuthorization',
    status: 'submission_dispatch_authorization_ready', paperId: 'real-paper-sandbox-fixture',
    provider: 'sandbox-provider', accountId: 'sandbox-account', nonce: `sandbox-${process.pid}` };
  const result = runProviderSandboxQuarantineProbe({
    companionEntry, expectedTechnicalContract: true,
    createStore: createDefaultPaperStore,
    createReceiptLedger: createSqliteReceiptLedger,
    createDeliveryStore: createSqliteSubmissionDeliveryStore, clock: createSystemClock(),
    dispatchAuthorization: { ...payload,
      submissionDispatchAuthorizationHash: hashRecord('SubmissionDispatchAuthorization', payload) },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
