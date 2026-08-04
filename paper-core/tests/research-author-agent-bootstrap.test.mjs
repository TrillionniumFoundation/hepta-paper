import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightCodexResearchAuthor } from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { probeCodexModelAvailability } from '../../paper-adapters/automation/codex-runtime-preflight.mjs';

function fixture(t, { loggedIn = true, privateHome = true, privateConfig = true,
  canaryMode = 'solve', rotateAuthDuringExec = false, configModel = null,
  rejectModelOverride = false, touchHomeDuringExec = false,
  failVersionOnce = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-research-author-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome, { mode: privateHome ? 0o700 : 0o775 });
  fs.chmodSync(codexHome, privateHome ? 0o700 : 0o775);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    ...(configModel ? [`model = ${JSON.stringify(configModel)}`] : []),
    'model_reasoning_effort = "high"',
    '',
  ].join('\n'), { mode: privateConfig ? 0o600 : 0o644 });
  fs.chmodSync(path.join(codexHome, 'config.toml'), privateConfig ? 0o600 : 0o644);
  if (rotateAuthDuringExec) {
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"fixture":"before"}\n', {
      mode: 0o600,
    });
  }
  const binary = path.join(root, 'codex');
  fs.writeFileSync(binary, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    `if (args[0] === '--version' && ${JSON.stringify(failVersionOnce)}) { const marker=path.join(process.env.CODEX_HOME, '.version-once'); if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(75); } }`,
    "if (args[0] === '--version') { console.log('codex-cli 99.1.0'); process.exit(0); }",
    "if (args[0] === 'exec' && args[1] === '--help') { console.log('Usage: codex exec --model MODEL'); process.exit(0); }",
    "if (args[0] === 'exec' && " + JSON.stringify(rejectModelOverride) + " && args.includes('--model')) process.exit(3);",
    "if (args[0] === 'exec') { let input=''; process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', () => { if (input.includes('HEPTA_CODEX_MODEL_CANARY_CHALLENGE')) { if ('" + canaryMode + "' === 'echo') console.log(input); else { const match=input.match(/Add decimal integers (\\d+) and (\\d+)/); console.log('HEPTA_CODEX_CANARY_RESPONSE:' + (Number(match[1]) + Number(match[2]))); } } else { if (" + JSON.stringify(touchHomeDuringExec) + ") fs.writeFileSync(path.join(process.env.CODEX_HOME, 'runtime-cache.json'), '{}\\n', {mode:0o600}); if (" + JSON.stringify(rotateAuthDuringExec) + ") fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), '{\"fixture\":\"after0\"}\\n', {mode:0o600}); console.log(JSON.stringify({status:'completed',summary:'ok',checksRun:[],blockers:[]})); } }); return; }",
    `if (args[0] === 'login' && args[1] === 'status') { console.log('${loggedIn ? 'Logged in' : 'Not logged in'}'); process.exit(${loggedIn ? 0 : 1}); }`,
    'process.exit(2);',
  ].join('\n'), { mode: 0o700 });
  fs.chmodSync(binary, 0o700);
  return { root, codexHome, binary };
}

function liveCanaryFailureSpawn(stderr) {
  return (_binary, args) => {
    if (args[0] === '--version') {
      return { status: 0, signal: null, stdout: 'codex-cli 99.1.0\n', stderr: '' };
    }
    if (args[0] === 'exec' && args[1] === '--help') {
      return { status: 0, signal: null, stdout: '--model MODEL\n', stderr: '' };
    }
    if (args[0] === 'login' && args[1] === 'status') {
      return { status: 0, signal: null, stdout: 'Logged in\n', stderr: '' };
    }
    assert.equal(args.includes('--ephemeral'), true);
    return { status: 86, signal: null, stdout: '', stderr };
  };
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail('expected callback to throw');
}

test('read-only Codex preflight retries one transient version probe failure', (t) => {
  const { codexHome, binary } = fixture(t, { failVersionOnce: true });
  const result = preflightCodexResearchAuthor({
    codexBinary: binary,
    codexHome,
    model: 'gpt-research-fixture',
  });
  assert.equal(result.capabilityReceipt.status, 'codex_research_author_capability_ready');
  assert.equal(fs.readFileSync(path.join(codexHome, '.version-once'), 'utf8'), '1');
});

test('research agents inherit the main CODEX_HOME model without a command override', async (t) => {
  const { codexHome, binary, root } = fixture(t, {
    configModel: 'gpt-main-agent-fixture',
    rejectModelOverride: true,
  });
  const preflight = preflightCodexResearchAuthor({ codexBinary: binary, codexHome });
  assert.equal(preflight.capabilityReceipt.model, 'gpt-main-agent-fixture');
  assert.equal(preflight.capabilityReceipt.modelSelectionSource, 'codex_home_config');
  const executor = createCodexAgentExecutor({
    codexBinary: preflight.codexBinary,
    codexHome: preflight.codexHome,
    model: null,
    principalId: preflight.effectivePrincipalId,
    researchAuthorCapabilityReceipt: preflight.capabilityReceipt,
  });
  const execution = await executor.execute({
    role: 'writer',
    workspacePath: root,
    instructions: 'Return the structured result without writing files.',
    context: {},
    sandbox: 'workspace-write',
  });
  assert.equal(execution.status, 'agent_execution_completed');
  assert.equal(execution.model, 'gpt-main-agent-fixture');
  assert.equal(execution.modelSelectionSource, 'codex_home_config');
  const canary = probeCodexModelAvailability({ codexBinary: binary, codexHome });
  assert.equal(canary.model, 'gpt-main-agent-fixture');
  assert.equal(canary.modelSelectionSource, 'codex_home_config');
});

test('research author preflight binds a private authenticated Codex runtime without exposing its home', (t) => {
  const { codexHome, binary } = fixture(t);
  const result = preflightCodexResearchAuthor({
    codexBinary: binary,
    codexHome,
    model: 'gpt-research-fixture',
  });
  assert.equal(result.capabilityReceipt.status, 'codex_research_author_capability_ready');
  assert.equal(result.capabilityReceipt.model, 'gpt-research-fixture');
  assert.equal(result.capabilityReceipt.assuranceScope, 'filesystem_credential_root_runtime_and_model_selection_preflight');
  assert.equal(result.capabilityReceipt.selectedModelExecutionCanaryVerified, false);
  assert.equal(result.capabilityReceipt.providerAccountIdentityAttested, false);
  assert.match(result.effectivePrincipalId, /^codex-research-author:[a-f0-9]{32}$/);
  assert.match(result.capabilityReceipt.codexResearchAuthorCapabilityReceiptHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result.capabilityReceipt).includes(codexHome), false);
});

test('preflighted research author capability is carried into the immutable execution receipt', async (t) => {
  const { codexHome, binary, root } = fixture(t);
  const preflight = preflightCodexResearchAuthor({
    codexBinary: binary,
    codexHome,
    model: 'gpt-research-fixture',
  });
  const executor = createCodexAgentExecutor({
    codexBinary: preflight.codexBinary,
    codexHome: preflight.codexHome,
    model: preflight.capabilityReceipt.model,
    principalId: preflight.effectivePrincipalId,
    researchAuthorCapabilityReceipt: preflight.capabilityReceipt,
  });
  const receipt = await executor.execute({
    role: 'writer',
    workspacePath: root,
    instructions: 'Write nothing; return the structured result.',
    sandbox: 'workspace-write',
  });
  assert.equal(receipt.status, 'agent_execution_completed');
  assert.equal(receipt.agentId, preflight.effectivePrincipalId);
  assert.equal(receipt.codexResearchAuthorCapabilityReceiptHash,
    preflight.capabilityReceipt.codexResearchAuthorCapabilityReceiptHash);
  assert.equal(receipt.codexResearchAuthorAssuranceScope,
    'filesystem_credential_root_runtime_and_model_selection_preflight');
  assert.equal(receipt.codexResearchAuthorProviderAccountIdentityAttested, false);
  assert.equal(JSON.stringify(receipt).includes(codexHome), false);
});

test('research author live canary proves the selected model can execute and binds the local runtime identity', (t) => {
  const { codexHome, binary } = fixture(t);
  const observedAt = new Date('2026-07-17T00:00:00.000Z');
  const canary = probeCodexModelAvailability({
    codexBinary: binary,
    codexHome,
    model: 'gpt-research-fixture',
    errorPrefix: 'research_author_codex',
    clock: { now: () => observedAt },
  });
  assert.equal(canary.status, 'codex_model_live_canary_verified');
  assert.equal(canary.selectedModelExecutionCanaryVerified, true);
  assert.equal(canary.externalActionPerformed, true);
  assert.equal(canary.observedAt, observedAt.toISOString());
  assert.equal(canary.expiresAt, '2026-07-17T00:15:00.000Z');
  assert.equal(JSON.stringify(canary).includes(codexHome), false);
});

test('research author live canary rechecks synchronous authority immediately before invocation', (t) => {
  const { codexHome, binary } = fixture(t);
  let invocationFenceCalls = 0;
  const canary = probeCodexModelAvailability({
    codexBinary: binary,
    codexHome,
    model: 'gpt-research-fixture',
    beforeModelInvocation() { invocationFenceCalls += 1; },
  });
  assert.equal(canary.selectedModelExecutionCanaryVerified, true);
  assert.equal(invocationFenceCalls, 1);

  let modelInvocations = 0;
  assert.throws(() => probeCodexModelAvailability({
    codexBinary: binary,
    codexHome,
    model: 'gpt-research-fixture',
    spawnSyncImpl(command, args, options) {
      if (args[0] === 'exec' && args.includes('--ephemeral')) modelInvocations += 1;
      return spawnSync(command, args, options);
    },
    beforeModelInvocation() { throw new Error('fixture_invocation_authority_stale'); },
  }), /fixture_invocation_authority_stale/);
  assert.equal(modelInvocations, 0);
});

test('research author live canary rejects a runtime that merely echoes its prompt', (t) => {
  const { codexHome, binary } = fixture(t, { canaryMode: 'echo' });
  assert.throws(() => probeCodexModelAvailability({
    codexBinary: binary,
    codexHome,
    model: 'gpt-research-fixture',
    errorPrefix: 'research_author_codex',
  }), /research_author_codex_model_live_canary_failed/);
});

test('unmanaged live canary stderr cannot self-assert quota or leak diagnostics', (t) => {
  const { codexHome, binary } = fixture(t);
  const quotaDetail = [
    'insufficient_quota',
    'credential=sk-live-canary-secret',
    'path=/private/provider/account.json',
    'response=provider-specific prose',
  ].join(' ');
  const quotaOptions = {
    codexBinary: binary,
    codexHome,
    model: 'gpt-research-fixture',
    errorPrefix: 'research_author_codex',
    spawnSyncImpl: liveCanaryFailureSpawn(quotaDetail),
  };
  const firstQuota = captureError(() => probeCodexModelAvailability(quotaOptions));
  const secondQuota = captureError(() => probeCodexModelAvailability(quotaOptions));
  assert.equal(firstQuota.message, 'research_author_codex_model_live_canary_failed');
  assert.equal(firstQuota.failureClass, 'unknown');
  assert.match(firstQuota.diagnosticHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(secondQuota.diagnosticHash, firstQuota.diagnosticHash);

  const unknownDetail = [
    'opaque-provider-failure',
    'credential=sk-unknown-secret',
    'path=/private/provider/unknown.json',
    'response=unstructured upstream prose',
  ].join(' ');
  const unknownOptions = {
    ...quotaOptions,
    spawnSyncImpl: liveCanaryFailureSpawn(unknownDetail),
  };
  const firstUnknown = captureError(() => probeCodexModelAvailability(unknownOptions));
  const secondUnknown = captureError(() => probeCodexModelAvailability(unknownOptions));
  assert.equal(firstUnknown.failureClass, 'unknown');
  assert.equal(secondUnknown.diagnosticHash, firstUnknown.diagnosticHash);
  assert.equal(firstUnknown.diagnosticHash, firstQuota.diagnosticHash);

  for (const [error, rawDetail] of [
    [firstQuota, quotaDetail],
    [firstUnknown, unknownDetail],
  ]) {
    assert.deepEqual(Object.keys(error).sort(), [
      'diagnosticHash', 'failureClass', 'retryable',
    ]);
    assert.equal(error.stdout, undefined);
    assert.equal(error.stderr, undefined);
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify({ message: error.message, ...error }).includes(rawDetail), false);
    assert.equal(JSON.stringify({ message: error.message, ...error }).includes('sk-'), false);
    assert.equal(JSON.stringify({ message: error.message, ...error }).includes('/private/'), false);
  }
});

test('preflighted research author revalidates binary and credential identity before every call', async (t) => {
  const { codexHome, binary, root } = fixture(t);
  const preflight = preflightCodexResearchAuthor({ codexBinary: binary, codexHome, model: 'fixture' });
  const executor = createCodexAgentExecutor({
    codexBinary: binary,
    codexHome,
    model: 'fixture',
    principalId: preflight.effectivePrincipalId,
    researchAuthorCapabilityReceipt: preflight.capabilityReceipt,
  });
  fs.appendFileSync(binary, '\n// replaced after preflight\n');
  await assert.rejects(() => executor.execute({
    role: 'writer',
    workspacePath: root,
    instructions: 'Return success.',
    sandbox: 'workspace-write',
  }), /research_author_codex_capability_runtime_identity_changed/);
});

test('preflighted research author rejects credential rotation during the Codex call', async (t) => {
  const { codexHome, binary, root } = fixture(t, { rotateAuthDuringExec: true });
  const preflight = preflightCodexResearchAuthor({
    codexBinary: binary,
    codexHome,
    model: 'fixture',
  });
  const executor = createCodexAgentExecutor({
    codexBinary: binary,
    codexHome,
    model: 'fixture',
    principalId: preflight.effectivePrincipalId,
    researchAuthorCapabilityReceipt: preflight.capabilityReceipt,
  });
  await assert.rejects(() => executor.execute({
    role: 'writer',
    workspacePath: root,
    instructions: 'Return success after rotating the fixture credential.',
    sandbox: 'workspace-write',
  }), (error) => {
    assert.match(error.message,
      /research_author_codex_capability_runtime_identity_changed_during_execution/);
    assert.equal(error.retryable, false);
    assert.equal(error.receipt?.status, 'agent_execution_failed');
    assert.equal(error.receipt?.blockers.includes(
      'research_author_codex_capability_runtime_identity_changed_during_execution',
    ), true);
    return true;
  });
});

test('preflighted research author permits non-credential Codex home cache activity', async (t) => {
  const { codexHome, binary, root } = fixture(t, { touchHomeDuringExec: true });
  const preflight = preflightCodexResearchAuthor({
    codexBinary: binary,
    codexHome,
    model: 'fixture',
  });
  const executor = createCodexAgentExecutor({
    codexBinary: binary,
    codexHome,
    model: 'fixture',
    principalId: preflight.effectivePrincipalId,
    researchAuthorCapabilityReceipt: preflight.capabilityReceipt,
  });
  const receipt = await executor.execute({
    role: 'writer',
    workspacePath: root,
    instructions: 'Return success after writing a non-credential cache entry.',
    sandbox: 'workspace-write',
  });
  assert.equal(receipt.status, 'agent_execution_completed');
  assert.deepEqual(receipt.blockers, []);
});

test('research author executor rejects a forged capability receipt even after outer fields are recomputed', (t) => {
  const { codexHome, binary } = fixture(t);
  const preflight = preflightCodexResearchAuthor({ codexBinary: binary, codexHome, model: 'fixture' });
  const forged = { ...preflight.capabilityReceipt, assuranceScope: 'provider-account-independent' };
  assert.throws(() => createCodexAgentExecutor({
    codexBinary: binary,
    codexHome,
    model: 'fixture',
    principalId: preflight.effectivePrincipalId,
    researchAuthorCapabilityReceipt: forged,
  }), /codex_research_author_capability_receipt_invalid/);
});

test('campaign worker composition preflights research-grade Codex authors before executor construction', () => {
  const source = fs.readFileSync(new URL('../../paper-composition/automation/campaign-worker-composition.mjs', import.meta.url), 'utf8');
  assert.match(source, /resolveCampaignAgentProviderPolicy\(/);
  assert.match(source, /researchAuthorProviderPolicy\.researchGradeRequired/);
  assert.match(source, /preflightResearchAuthor = preflightCodexResearchAuthor/);
  assert.match(source, /preflightResearchAuthor\(\{/);
  assert.match(source, /researchAuthorCapabilityReceipt:\s*researchAuthorPreflight\?\.capabilityReceipt/);
  assert.doesNotMatch(source, /createAgentBackendRouter\(\{\s*primary:\s*openclaw,\s*fallbacks:\s*\[ollama,?\s*codex/);
});

test('research author preflight fails closed for missing model, public credentials, symlink home, and logged-out runtime', (t) => {
  const ready = fixture(t);
  assert.throws(() => preflightCodexResearchAuthor({
    codexBinary: ready.binary,
    codexHome: ready.codexHome,
  }), /research_author_codex_model_required/);
  const publicHome = fixture(t, { privateHome: false });
  assert.throws(() => preflightCodexResearchAuthor({
    codexBinary: publicHome.binary,
    codexHome: publicHome.codexHome,
    model: 'fixture',
  }), /research_author_codex_home_permissions_invalid/);
  const publicConfig = fixture(t, { privateConfig: false });
  assert.throws(() => preflightCodexResearchAuthor({
    codexBinary: publicConfig.binary,
    codexHome: publicConfig.codexHome,
    model: 'fixture',
  }), /research_author_codex_config_permissions_invalid/);
  const linkedHome = path.join(publicConfig.root, 'linked-codex-home');
  fs.symlinkSync(ready.codexHome, linkedHome, 'dir');
  assert.throws(() => preflightCodexResearchAuthor({
    codexBinary: ready.binary,
    codexHome: linkedHome,
    model: 'fixture',
  }), /research_author_codex_home_invalid/);
  const loggedOut = fixture(t, { loggedIn: false });
  assert.throws(() => preflightCodexResearchAuthor({
    codexBinary: loggedOut.binary,
    codexHome: loggedOut.codexHome,
    model: 'fixture',
  }), /research_author_codex_authentication_required/);
});
