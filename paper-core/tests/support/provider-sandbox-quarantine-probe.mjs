import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Test orchestration only. Injected ports keep this helper independent of
// production implementations. Fixture controls never qualify a companion.
const MAX_RESPONSE_BYTES = 64 * 1024;

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function preflightCompanion(entry) {
  if (typeof entry !== 'string' || !path.isAbsolute(entry)) {
    fail('provider_sandbox_companion_path_invalid');
  }
  let info;
  try { info = fs.lstatSync(entry); }
  catch (error) {
    fail(error.code === 'ENOENT' ? 'provider_sandbox_companion_missing'
      : 'provider_sandbox_companion_unreadable', error);
  }
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024
    || fs.realpathSync(entry) !== entry) {
    fail('provider_sandbox_companion_unsafe');
  }
}

function readResponse(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n
      || before.size > BigInt(MAX_RESPONSE_BYTES)) {
      fail('provider_sandbox_response_unsafe');
    }
    const raw = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < raw.length) {
      const count = fs.readSync(fd, raw, offset, raw.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (offset !== Number(before.size)
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some((key) => before[key] !== after[key])) {
      fail('provider_sandbox_response_changed');
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, offset)));
    } catch (error) { fail('provider_sandbox_response_malformed', error); }
  } catch (error) {
    if (String(error.code).startsWith('provider_sandbox_')) throw error;
    fail(error.code === 'ENOENT' ? 'provider_sandbox_response_missing'
      : 'provider_sandbox_response_unreadable', error);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function runProviderSandboxQuarantineProbe({
  companionEntry, createStore, createReceiptLedger, createDeliveryStore,
  clock, dispatchAuthorization, temporaryParent = os.tmpdir(), timeoutMs = 10000,
}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000);
  preflightCompanion(companionEntry); // No store/outbox/tmp allocation on missing source.
  const runtimeRoot = fs.mkdtempSync(path.join(temporaryParent, 'provider-integration-'));
  let store;
  try {
    store = createStore({ root: runtimeRoot, runtimeRoot });
    const receiptLedger = createReceiptLedger({ store, clock });
    const delivery = createDeliveryStore({ store, receiptLedger, clock });
    const outbox = delivery.enqueue({ paperId: dispatchAuthorization.paperId,
      dispatchAuthorization, payload: { packageHash: 'sha256:sandbox-package' } });
    const input = path.join(runtimeRoot, 'request.json');
    const output = path.join(runtimeRoot, 'response.json');
    fs.writeFileSync(input, JSON.stringify({
      environment: 'provider_sandbox', liveActionAllowed: false,
      provider: dispatchAuthorization.provider, accountId: dispatchAuthorization.accountId,
      paperId: dispatchAuthorization.paperId,
      dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
      packageHash: 'sha256:sandbox-package',
    }), { mode: 0o600, flag: 'wx' });
    // Do not inherit credentials, NODE_OPTIONS, proxies, or parent runtime roots.
    // This is a bounded test child, not a claim of OS/network sandbox isolation.
    const result = spawnSync(process.execPath, [companionEntry, input, output], {
      encoding: 'utf8', cwd: runtimeRoot, shell: false,
      timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_RESPONSE_BYTES,
      env: { PATH: '/usr/bin:/bin', HOME: runtimeRoot, TMPDIR: runtimeRoot,
        LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    });
    if (result.error?.code === 'ETIMEDOUT') fail('provider_sandbox_companion_timeout');
    if (result.error || result.signal || result.status !== 0) {
      fail('provider_sandbox_companion_failed');
    }
    const response = readResponse(output);
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
