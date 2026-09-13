import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { runProviderSandboxQuarantineProbe } from './support/provider-sandbox-quarantine-probe.mjs';

// These local child fixtures exercise cleanup only. They are never selected by
// provider-sandbox-integration.test.mjs and cannot qualify the missing companion.
function runChild(mode, parent) {
  const entry = path.join(parent, 'local-failure-control.mjs');
  const response = { providerReceipt: { sandbox: mode !== 'assertion' },
    externalActionPerformed: false };
  let source = `import fs from 'node:fs';
    const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const response = { ...${JSON.stringify(response)}, responseId: 'local-cleanup-control',
      outcome: 'failed', dispatchAuthorizationHash: request.dispatchAuthorizationHash };
    fs.writeFileSync(process.argv[3], JSON.stringify(response));`;
  if (mode === 'nonzero') source = 'process.exit(17);';
  if (mode === 'malformed') source = "import fs from 'node:fs'; fs.writeFileSync(process.argv[3], '{bad');";
  if (mode === 'response-missing') source = 'process.exit(0);';
  if (mode === 'response-link') source = "import fs from 'node:fs'; fs.symlinkSync(process.argv[2], process.argv[3]);";
  if (mode === 'response-oversize') source = "import fs from 'node:fs'; fs.writeFileSync(process.argv[3], 'x'.repeat(65537));";
  if (mode === 'timeout') source = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  if (mode === 'environment') source = "import fs from 'node:fs'; if(process.env.HEPTA_TEST_PRIVATE_CANARY || process.env.NODE_OPTIONS) process.exit(29); " + source.replace("import fs from 'node:fs';", '');
  if (mode !== 'missing') fs.writeFileSync(entry, source);
  if (mode === 'entry-link') {
    fs.renameSync(entry, `${entry}.real`);
    fs.symlinkSync(`${entry}.real`, entry);
  }
  const audit = { allocations: 0, closeCalls: 0, runtimeRoot: null,
    localFailureControl: true, companionQualified: false };
  const payload = { version: 1, kind: 'SubmissionDispatchAuthorization',
    status: 'submission_dispatch_authorization_ready', paperId: 'cleanup-control',
    provider: 'sandbox-provider', accountId: 'sandbox-account', nonce: `control-${process.pid}` };
  try {
    runProviderSandboxQuarantineProbe({
      companionEntry: entry, temporaryParent: parent, timeoutMs: mode === 'timeout' ? 150 : 5000,
      createStore(options) {
        audit.allocations += 1;
        audit.runtimeRoot = options.runtimeRoot;
        if (mode === 'store-error') throw new Error('injected_store_failure');
        const store = createDefaultPaperStore(options);
        return { ...store, close() {
          audit.closeCalls += 1;
          store.close();
          if (mode === 'close-error') throw new Error('injected_close_failure');
        } };
      },
      createReceiptLedger: createSqliteReceiptLedger,
      createDeliveryStore: createSqliteSubmissionDeliveryStore, clock: createSystemClock(),
      dispatchAuthorization: { ...payload,
        submissionDispatchAuthorizationHash: hashRecord('SubmissionDispatchAuthorization', payload) },
    });
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.code || error.message}: ${error.message}\n`);
    audit.failureStack = error.stack;
  } finally {
    audit.runtimeRemoved = audit.runtimeRoot === null || !fs.existsSync(audit.runtimeRoot);
    fs.writeFileSync(path.join(parent, 'audit.json'), JSON.stringify(audit));
  }
}

if (process.argv[2] === '--provider-lifecycle-child') {
  runChild(process.argv[3], process.argv[4]);
} else {
  for (const [mode, expectedCode, allocations, closeCalls] of [
    ['missing', 'provider_sandbox_companion_missing', 0, 0],
    ['entry-link', 'provider_sandbox_companion_unsafe', 0, 0],
    ['nonzero', 'provider_sandbox_companion_failed', 1, 1],
    ['malformed', 'provider_sandbox_response_malformed', 1, 1],
    ['response-missing', 'provider_sandbox_response_missing', 1, 1],
    ['response-link', 'provider_sandbox_response_unreadable', 1, 1],
    ['response-oversize', 'provider_sandbox_response_unsafe', 1, 1],
    ['timeout', 'provider_sandbox_companion_timeout', 1, 1],
    ['assertion', 'ERR_ASSERTION', 1, 1],
    ['store-error', 'injected_store_failure', 1, 0],
    ['close-error', 'injected_close_failure', 1, 1],
    ['control', null, 1, 1],
    ['environment', null, 1, 1],
  ]) {
    test(`local provider lifecycle control: ${mode}; never companion qualification`, (t) => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-lifecycle-'));
      t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
      fs.writeFileSync(path.join(parent, 'unowned-sentinel'), 'preserve');
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url),
        '--provider-lifecycle-child', mode, parent], {
        encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin', HOME: parent, TMPDIR: parent,
          HEPTA_TEST_PRIVATE_CANARY: 'test-only-not-a-real-secret' },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedCode ? 1 : 0, result.stderr);
      if (expectedCode) assert.ok(result.stderr.includes(expectedCode), result.stderr);
      if (mode === 'assertion') assert.ok(result.stderr.includes('false !== true'), result.stderr);
      const audit = JSON.parse(fs.readFileSync(path.join(parent, 'audit.json'), 'utf8'));
      assert.equal(audit.allocations, allocations);
      assert.equal(audit.closeCalls, closeCalls);
      assert.equal(audit.runtimeRemoved, true);
      assert.equal(audit.companionQualified, false);
      assert.deepEqual(fs.readdirSync(parent).filter((name) => name.startsWith('provider-integration-')), []);
      assert.equal(fs.readFileSync(path.join(parent, 'unowned-sentinel'), 'utf8'), 'preserve');
    });
  }
}
