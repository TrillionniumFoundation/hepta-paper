import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  managedRuntimeTimeoutBudget,
} from '../../paper-adapters/automation/codex-agent-executor.mjs';
import {
  gatewayAgentTimeoutBudget,
} from '../../paper-adapters/automation/codex-openclaw-managed-gateway-transport.mjs';
import {
  runManagedOneShotAgentCommand,
} from '../../paper-adapters/automation/codex-openclaw-managed-one-shot-session.mjs';
import {
  provisionCodexOpenClawManagedHome,
  readCodexOpenClawManagedConfiguration,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  GATEWAY_ABORT_WINDOW_MS,
  GATEWAY_CLEANUP_WINDOW_MS,
  GATEWAY_SESSION_DELETE_WINDOW_MS,
  GATEWAY_TERMINAL_WAIT_WINDOW_MS,
  closeGatewayAttemptWorkspace,
  openGatewayAttemptWorkspace,
  removeGatewayAttemptWorkspace,
} from '../../paper-adapters/automation/codex-openclaw-managed-gateway-reconciliation.mjs';
import {
  AUTH_PROFILE_ID,
  fixture,
} from './support/codex-openclaw-managed-runtime-fixture.mjs';

const ATTEMPT_ID = '20000000-0000-4000-8000-000000000002';

function gatewayTemporaryWorkspaces() {
  return new Set(fs.readdirSync('/tmp').filter(
    (entry) => entry.startsWith('hepta-managed-gateway-rpc-'),
  ));
}

function gatewayConfiguration(value) {
  provisionCodexOpenClawManagedHome({
    home: value.home,
    agentId: 'hepta-paper-worker',
    authProfileId: AUTH_PROFILE_ID,
    model: 'gpt-5.6-sol',
    openclawBinary: path.join(value.root, 'openclaw'),
    openclawConfigPath: value.openclawConfigPath,
    openclawStateDir: value.openclawStateDir,
    principalRole: 'research-author',
    thinking: 'adaptive',
    gatewayTransport: true,
    force: true,
  });
  return readCodexOpenClawManagedConfiguration({
    environment: value.environment,
  });
}

test('managed and Gateway cleanup budgets preserve the full delete barrier', () => {
  assert.deepEqual(managedRuntimeTimeoutBudget(20 * 60_000), {
    cleanupReserveMs: 300_000,
    innerTimeoutMs: 900_000,
  });
  assert.deepEqual(managedRuntimeTimeoutBudget(10 * 60_000), {
    cleanupReserveMs: 240_000,
    innerTimeoutMs: 360_000,
  });
  assert.throws(
    () => managedRuntimeTimeoutBudget(241_249),
    /codex_agent_managed_timeout_budget_invalid/,
  );
  assert.ok(
    Math.max(GATEWAY_ABORT_WINDOW_MS, GATEWAY_TERMINAL_WAIT_WINDOW_MS)
      + GATEWAY_SESSION_DELETE_WINDOW_MS <= GATEWAY_CLEANUP_WINDOW_MS,
  );
  assert.deepEqual(gatewayAgentTimeoutBudget(5000), {
    clientTimeoutMs: 5000,
    graceMs: 250,
    serverTimeoutSeconds: 4,
  });
  for (const insufficient of [250, 500, 1000, 1249]) {
    assert.throws(
      () => gatewayAgentTimeoutBudget(insufficient),
      /codex_openclaw_managed_model_timeout/,
    );
  }
  const minimum = gatewayAgentTimeoutBudget(1250);
  assert.ok(minimum.serverTimeoutSeconds * 1000 < minimum.clientTimeoutMs);
});

test('temporary-workspace replacement is preserved and not recursively removed', () => {
  const workspace = fs.mkdtempSync(path.join('/tmp', 'hepta-managed-gateway-rpc-'));
  fs.chmodSync(workspace, 0o700);
  const original = `${workspace}.owned-original`;
  const pinned = openGatewayAttemptWorkspace(workspace);
  try {
    fs.renameSync(workspace, original);
    fs.mkdirSync(workspace, { mode: 0o700 });
    const sentinel = path.join(workspace, 'sentinel');
    fs.writeFileSync(sentinel, 'replacement\n', { mode: 0o600 });
    assert.throws(
      () => removeGatewayAttemptWorkspace(pinned),
      /temporary_workspace_removal_failed/,
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'replacement\n');
    assert.equal(fs.existsSync(original), true);
  } finally {
    closeGatewayAttemptWorkspace(pinned);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(original, { recursive: true, force: true });
  }
});

for (const workspaceFailure of ['chmod', 'scope-open']) {
  test(`Gateway ${workspaceFailure} failure removes its exact temp directory`, async () => {
    const value = fixture();
    const originalChmod = fs.chmodSync;
    const originalOpen = fs.openSync;
    let injected = false;
    try {
      const configuration = gatewayConfiguration(value);
      const before = gatewayTemporaryWorkspaces();
      fs.chmodSync = (candidate, mode) => {
        if (workspaceFailure === 'chmod' && !injected
          && path.basename(candidate).startsWith('hepta-managed-gateway-rpc-')) {
          injected = true;
          throw new Error('fixture chmod failure');
        }
        return originalChmod(candidate, mode);
      };
      fs.openSync = (...args) => {
        if (workspaceFailure === 'scope-open' && !injected
          && path.basename(String(args[0]))
            .startsWith('hepta-managed-gateway-rpc-')) {
          injected = true;
          throw new Error('fixture open failure');
        }
        return Reflect.apply(originalOpen, fs, args);
      };
      await assert.rejects(
        runManagedOneShotAgentCommand({ configuration, attemptId: ATTEMPT_ID }),
      );
      assert.equal(injected, true);
      assert.deepEqual(gatewayTemporaryWorkspaces(), before);
    } finally {
      fs.chmodSync = originalChmod;
      fs.openSync = originalOpen;
      value.cleanup();
    }
  });
}
