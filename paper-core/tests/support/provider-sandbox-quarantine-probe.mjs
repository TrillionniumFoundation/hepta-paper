import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectProviderSandboxCompanion, runProviderSandboxProcess }
  from '../../../paper-adapters/submission/provider-sandbox-process.mjs';

// Fixture controls exercise the same process adapter; they never qualify a companion.
export function runProviderSandboxQuarantineProbe({
  companionEntry, createStore, createReceiptLedger, createDeliveryStore,
  clock, dispatchAuthorization, temporaryParent = os.tmpdir(), timeoutMs = 10000,
}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000);
  inspectProviderSandboxCompanion(companionEntry); // No store/outbox/tmp allocation on missing source.
  const runtimeRoot = fs.mkdtempSync(path.join(temporaryParent, 'provider-integration-'));
  let store;
  try {
    store = createStore({ root: runtimeRoot, runtimeRoot });
    const receiptLedger = createReceiptLedger({ store, clock });
    const delivery = createDeliveryStore({ store, receiptLedger, clock });
    const outbox = delivery.enqueue({ paperId: dispatchAuthorization.paperId,
      dispatchAuthorization, payload: { packageHash: 'sha256:sandbox-package' } });
    const response = runProviderSandboxProcess({
      companionEntry, runtimeRoot, timeoutMs,
      request: { environment: 'provider_sandbox', liveActionAllowed: false,
        provider: dispatchAuthorization.provider, accountId: dispatchAuthorization.accountId,
        paperId: dispatchAuthorization.paperId,
        dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
        packageHash: 'sha256:sandbox-package' },
    });
    assert.throws(() => delivery.recordResponse({ messageId: outbox.message_id, response }),
      /executor response rejected/);
    assert.equal(delivery.listQuarantine({ messageId: outbox.message_id }).length, 1);
    assert.equal(delivery.acquireReleaseLock({ paperId: dispatchAuthorization.paperId,
      messageId: outbox.message_id, lockToken: `lock-${process.pid}` })?.status, 'locked');
    assert.equal(response.providerReceipt.sandbox, true);
    assert.equal(response.externalActionPerformed, false);
    return { ok: true, status: 'provider_sandbox_incomplete_response_quarantined',
      outbox: 1, inbox: 0, quarantine: 1, reconciliation: 0, externalActionPerformed: false };
  } finally {
    try { store?.close(); }
    finally { fs.rmSync(runtimeRoot, { recursive: true, force: true }); }
  }
}
