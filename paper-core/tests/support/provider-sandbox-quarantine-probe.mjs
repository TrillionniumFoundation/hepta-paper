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
  expectedTechnicalContract = false,
}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000);
  const companion = inspectProviderSandboxCompanion(companionEntry); // No allocation on missing source.
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
      /invalid executor response|executor response rejected/);
    assert.equal(delivery.listQuarantine({ messageId: outbox.message_id }).length, 1);
    assert.equal(delivery.acquireReleaseLock({ paperId: dispatchAuthorization.paperId,
      messageId: outbox.message_id, lockToken: `lock-${process.pid}` })?.status, 'locked');
    assert.equal(response.providerReceipt.sandbox, true);
    assert.equal(response.externalActionPerformed, false);
    if (expectedTechnicalContract) {
      assert.equal(response.kind, 'ProviderTechnicalSandboxResponseV1');
      assert.equal(response.status,
        'technical_sandbox_response_incomplete_for_external_acceptance');
      assert.equal(response.companionVersion, 'provider-technical-sandbox-v1');
    }
    assert.equal(Number(store.query('SELECT COUNT(*) AS count FROM submission_inbox;')
      .rows[0]?.count), 0);
    assert.equal(Number(store.query(
      'SELECT COUNT(*) AS count FROM submission_release_locks WHERE reconciliation_hash IS NOT NULL;',
    ).rows[0]?.count), 0);
    const ledgerRows = receiptLedger.listRawForAudit({ stream: 'submission-delivery' });
    assert.deepEqual(ledgerRows.map((row) => row.kind),
      ['SubmissionIntakeQuarantineReceipt']);
    assert.equal(ledgerRows.some((row) => row.kind === 'SubmissionResponsePersistedReceipt'), false);
    return {
      ok: true,
      status: 'provider_sandbox_incomplete_response_quarantined',
      companionSha256: `sha256:${companion.sha256}`,
      companionVersion: response.companionVersion || null,
      outbox: 1,
      inbox: 0,
      quarantine: 1,
      acceptedDeliveryReceipts: 0,
      quarantineReceipts: 1,
      reconciliation: 0,
      externalActionPerformed: false,
    };
  } finally {
    try { store?.close(); }
    finally { fs.rmSync(runtimeRoot, { recursive: true, force: true }); }
  }
}
