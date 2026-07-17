import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { createOpenClawAgentExecutor, openClawAgentCapabilityProfileHash } from '../../paper-adapters/automation/openclaw-agent-executor.mjs';
import {
  createOpenClawRuntimeConfigurationResolver,
  openClawAgentConfigurationHash,
  openClawGatewayConfigurationHash,
} from '../../paper-adapters/automation/openclaw-agent-configuration.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function openClawRuntimeConfiguration(agentId, workspace, sandbox = 'workspace-write') {
  const writable = sandbox === 'workspace-write';
  const allow = writable ? ['apply_patch', 'edit', 'exec', 'process', 'read', 'write'] : ['read'];
  const runtimeConfig = {
    agents: {
      defaults: {},
      list: [{
        id: agentId,
        runtime: { type: 'embedded' },
        workspace,
        skills: [],
        subagents: { allowAgents: [] },
        sandbox: {
          mode: 'all',
          backend: 'docker',
          scope: 'session',
          workspaceAccess: writable ? 'rw' : 'ro',
          docker: {
            network: 'none',
            readOnlyRoot: true,
            capDrop: ['ALL'],
            binds: [],
            env: {},
            pidsLimit: 64,
            memory: '1g',
            memorySwap: '1g',
            cpus: 2,
            user: '1000:1000',
          },
          browser: { enabled: false, allowHostControl: false, binds: [] },
        },
        tools: {
          allow,
          elevated: { enabled: false },
          fs: { workspaceOnly: true },
          exec: {
            host: 'sandbox',
            mode: writable ? 'allowlist' : 'deny',
            security: writable ? 'allowlist' : 'deny',
            ask: 'off',
            strictInlineEval: true,
            pathPrepend: [],
            safeBins: [],
            safeBinTrustedDirs: [],
            safeBinProfiles: {},
            applyPatch: { workspaceOnly: true },
          },
          sandbox: { tools: { allow } },
          subagents: { tools: { allow: [] } },
        },
      }],
    },
    tools: {},
  };
  return {
    gatewayInstanceId: 'fixture-gateway-instance',
    gatewayUrl: 'ws://127.0.0.1:18789',
    gatewayConfigPath: '/fixture/openclaw.json',
    snapshot: {
      valid: true,
      hash: crypto.createHash('sha256').update(JSON.stringify(runtimeConfig)).digest('hex'),
      runtimeConfig,
    },
  };
}

function openClawPolicy(
  agentId = 'hepta-paper-worker',
  workspace = process.cwd(),
  sandbox = 'workspace-write',
  resolvedConfiguration = openClawRuntimeConfiguration(agentId, workspace, sandbox),
  openClawConfigurationResolver = async () => resolvedConfiguration,
) {
  const agentCapabilityProfile = Object.freeze({
    version: 2,
    kind: 'OpenClawAgentCapabilityProfile',
    agentId,
    enforcement: 'openclaw-gateway-runtime-configuration',
    delivery: 'disabled',
    toolPolicy: Object.freeze({
      messaging: 'denied',
      externalMutation: 'denied',
      credentialAccess: 'denied',
    }),
    openClawAgentConfigurationHash: openClawAgentConfigurationHash(resolvedConfiguration, agentId),
    openClawGatewayConfigurationHash: openClawGatewayConfigurationHash(resolvedConfiguration, agentId),
  });
  return {
    agentCapabilityProfile,
    expectedAgentCapabilityProfileHash: openClawAgentCapabilityProfileHash(agentCapabilityProfile),
    openClawConfigurationResolver,
  };
}

function rehashOpenClawRuntimeConfiguration(resolvedConfiguration) {
  resolvedConfiguration.snapshot.hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(resolvedConfiguration.snapshot.runtimeConfig))
    .digest('hex');
  return resolvedConfiguration;
}

function executable(root, name, source) {
  const candidate = path.join(root, name);
  fs.writeFileSync(candidate, source);
  fs.chmodSync(candidate, 0o755);
  return candidate;
}

function cancellableChildProcess() {
  const child = new EventEmitter();
  child.pid = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = (signal) => {
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function completedChildProcess(stdout) {
  const child = new EventEmitter();
  child.pid = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end();
    child.emit('close', 0, null);
  });
  return child;
}

function verifyAndNormalizeReceipt(receipt) {
  const payload = { ...receipt };
  delete payload.agentExecutionReceiptHash;
  assert.equal(receipt.agentExecutionReceiptHash, hashRecord('AgentExecutionReceipt', payload));
  const normalized = {
    ...receipt,
    promptHash: '<prompt-hash>',
    startedAt: '<started-at>',
    completedAt: '<completed-at>',
    agentExecutionReceiptHash: '<receipt-hash>',
  };
  if (normalized.sessionKey) normalized.sessionKey = '<session-key>';
  if (/^(codex|ollama)-exec:/.test(normalized.sessionId || '')) normalized.sessionId = '<session-id>';
  if (/^(codex|ollama)-exec:/.test(normalized.childSessionId || '')) normalized.childSessionId = '<session-id>';
  return normalized;
}

test('agent executor capability declarations remain exact across provider strategies', () => {
  const timeoutMs = 1000;
  const openclaw = createOpenClawAgentExecutor({ timeoutMs });
  const codex = createCodexAgentExecutor({ timeoutMs });
  const ollama = createOllamaStructuredAgentExecutor({ model: 'fixture-ollama', timeoutMs, maximumOutputTokens: 512 });
  const common = {
    version: 1,
    kind: 'ExecutorCapabilities',
    sandboxModes: ['read-only', 'workspace-write'],
    externalActions: false,
    workspaceIsolation: false,
    languages: ['*'],
    gpu: false,
    maximumTimeoutMs: timeoutMs,
    receiptKinds: ['AgentExecutionReceipt'],
  };
  assert.deepEqual(openclaw.capabilities(), {
    ...common,
    executorId: 'openclaw-agent-executor-v1',
    networkPolicy: 'provider-controlled',
    maximumOutputTokens: null,
    provider: 'openclaw',
  });
  assert.deepEqual(codex.capabilities(), {
    ...common,
    executorId: 'codex-agent-executor-v1',
    networkPolicy: 'sandbox-restricted',
    maximumOutputTokens: null,
    provider: 'openai',
  });
  assert.deepEqual(ollama.capabilities(), {
    ...common,
    executorId: 'ollama-structured-agent-v1',
    networkPolicy: 'local-provider-only',
    maximumOutputTokens: 512,
    provider: 'ollama',
  });
});

test('Codex receipt golden preserves fields, workspace diff, prompt hash and provider output', async (t) => {
  const root = temporary(t, 'hepta-codex-template-golden-');
  const output = '{"status":"completed","summary":"codex-ok","checksRun":[],"blockers":[]}\n';
  const shim = executable(root, 'codex-shim.sh', `#!/bin/sh\ncat >/dev/null\nprintf 'codex-change\\n' > codex.txt\nprintf '%s' '${output}'\n`);
  const executor = createCodexAgentExecutor({ codexBinary: shim, model: 'fixture-codex', timeoutMs: 5000 });
  const receipt = await executor.execute({
    role: 'writer',
    workspacePath: root,
    instructions: 'write the fixture',
    context: { campaignId: 'campaign-1' },
    requiredChecks: ['check-a'],
    outputTokenBudget: 222,
  });
  assert.deepEqual(verifyAndNormalizeReceipt(receipt), {
    version: 1,
    kind: 'AgentExecutionReceipt',
    executorId: 'codex-agent-executor-v1',
    providerMode: 'openai',
    agentId: null,
    model: 'fixture-codex',
    resolvedModel: 'fixture-codex',
    promptHash: '<prompt-hash>',
    sessionId: '<session-id>',
    childSessionId: '<session-id>',
    maximumOutputTokens: 222,
    role: 'writer',
    status: 'agent_execution_completed',
    exitCode: 0,
    signal: null,
    changedPaths: ['codex.txt'],
    blockers: [],
    stdoutHash: sha256(output),
    stderrHash: sha256(''),
    outputTruncated: false,
    finalOutput: output,
    structuredOutput: {
      status: 'completed',
      summary: 'codex-ok',
      checksRun: [],
      blockers: [],
    },
    stderrTail: '',
    error: null,
    startedAt: '<started-at>',
    completedAt: '<completed-at>',
    externalActionPerformed: false,
    externalActionVerification: 'codex_sandbox_policy',
    agentExecutionReceiptHash: '<receipt-hash>',
  });
});

test('Codex parses a bounded complete formal-review document larger than its display tail', async (t) => {
  const root = temporary(t, 'hepta-codex-large-review-');
  const structuredOutput = {
    kind: 'FormalClaimSemanticReview',
    status: 'completed',
    summary: 'complete review',
    checksRun: [],
    blockers: [],
    claims: Array.from({ length: 160 }, (_, index) => ({
      claimKey: `claim-${index}`,
      verdict: 'equivalent',
      rationale: 'The natural-language claim and formal statement have matching assumptions and conclusion.',
    })),
  };
  const output = `${JSON.stringify(structuredOutput)}\n`;
  assert.ok(Buffer.byteLength(output) > 12000);
  const executor = createCodexAgentExecutor({
    timeoutMs: 5000,
    spawnImpl: () => completedChildProcess(output),
  });

  const receipt = await executor.execute({
    role: 'formal-reviewer',
    workspacePath: root,
    instructions: 'review every formal claim',
    sandbox: 'read-only',
  });

  assert.equal(receipt.status, 'agent_execution_completed');
  assert.equal(receipt.structuredOutput.kind, 'FormalClaimSemanticReview');
  assert.equal(receipt.structuredOutput.claims.length, 160);
  assert.ok(Buffer.byteLength(receipt.finalOutput) <= 12000);
});

test('agent workspace diff ignores materialization recovery state', async (t) => {
  const root = temporary(t, 'hepta-agent-recovery-diff-');
  const recovery = path.join(root, '.hepta-materialization-recovery');
  fs.mkdirSync(recovery);
  fs.writeFileSync(path.join(recovery, 'completed-operation.tombstone'), 'before\n');
  const output = '{"status":"completed","summary":"ok","checksRun":[],"blockers":[]}\n';
  const shim = executable(root, 'codex-recovery-shim.sh', `#!/bin/sh\ncat >/dev/null\nprintf 'after\\n' > .hepta-materialization-recovery/completed-operation.tombstone\nprintf 'paper change\\n' > visible.txt\nprintf '%s' '${output}'\n`);
  const executor = createCodexAgentExecutor({ codexBinary: shim, timeoutMs: 5000 });

  const receipt = await executor.execute({ role: 'writer', workspacePath: root, instructions: 'write the fixture' });

  assert.deepEqual(receipt.changedPaths, ['visible.txt']);
  assert.equal(fs.readFileSync(path.join(recovery, 'completed-operation.tombstone'), 'utf8'), 'after\n');
});

test('OpenClaw receipt golden preserves detached-session parsing and usage fields', async (t) => {
  const root = temporary(t, 'hepta-openclaw-template-golden-');
  const structuredOutput = { status: 'completed', summary: 'openclaw-ok', checksRun: [], blockers: [] };
  const providerOutput = {
    runId: 'run-1',
    result: {
      payloads: [{ text: JSON.stringify(structuredOutput) }],
      meta: { agentMeta: { sessionId: 'child-1', modelId: 'resolved-openclaw', usage: { input: 7, output: 3, total: 10 } } },
    },
  };
  const stdout = `${JSON.stringify(providerOutput)}\n`;
  const shim = executable(root, 'openclaw-shim.sh', `#!/bin/sh\nprintf 'openclaw-change\\n' > openclaw.txt\nprintf '%s' '${stdout}'\n`);
  const openclawPolicy = openClawPolicy('fixture-agent', root);
  const executor = createOpenClawAgentExecutor({
    openclawBinary: shim,
    agentId: 'fixture-agent',
    model: 'declared-openclaw',
    timeoutMs: 5000,
    ...openclawPolicy,
  });
  const receipt = await executor.execute({
    role: 'reviewer',
    workspacePath: root,
    instructions: 'review the fixture',
    context: { campaignId: 'campaign-1', nodeId: 'node-1' },
    requiredChecks: ['check-a'],
    outputTokenBudget: 333,
  });
  assert.deepEqual(verifyAndNormalizeReceipt(receipt), {
    version: 1,
    kind: 'AgentExecutionReceipt',
    executorId: 'openclaw-agent-executor-v1',
    providerMode: 'openclaw:detached-child-session',
    agentId: 'fixture-agent',
    model: 'declared-openclaw',
    resolvedModel: 'resolved-openclaw',
    promptHash: '<prompt-hash>',
    maximumOutputTokens: 333,
    role: 'reviewer',
    sessionKey: '<session-key>',
    sessionId: 'child-1',
    childSessionId: 'child-1',
    status: 'agent_execution_completed',
    exitCode: 0,
    signal: null,
    changedPaths: ['openclaw.txt'],
    finalOutput: JSON.stringify(structuredOutput),
    structuredOutput,
    openClawRunId: 'run-1',
    usage: { input: 7, output: 3, total: 10 },
    agentCapabilityProfileHash: openclawPolicy.expectedAgentCapabilityProfileHash,
    openClawAgentConfigurationHash: openclawPolicy.agentCapabilityProfile.openClawAgentConfigurationHash,
    openClawGatewayConfigurationHash: openclawPolicy.agentCapabilityProfile.openClawGatewayConfigurationHash,
    openClawGatewayInstanceId: 'fixture-gateway-instance',
    openClawConfigurationReverified: true,
    blockers: [],
    stdoutHash: sha256(stdout),
    stderrHash: sha256(''),
    outputTruncated: false,
    stderrTail: '',
    startedAt: '<started-at>',
    completedAt: '<completed-at>',
    externalActionPerformed: null,
    externalActionVerification: 'not_observed:openclaw_gateway_runtime_configuration_bound_pre_and_post',
    agentExecutionReceiptHash: '<receipt-hash>',
  });
});

test('OpenClaw requires a hash-bound least-authority profile and keeps prompts and ambient secrets out of argv/env', async (t) => {
  const root = temporary(t, 'hepta-openclaw-policy-');
  let spawnCalls = 0;
  const unverified = createOpenClawAgentExecutor({
    agentId: 'fixture-agent',
    spawnImpl() { spawnCalls += 1; throw new Error('unverified execution must not spawn'); },
  });
  await assert.rejects(
    () => unverified.execute({ role: 'reviewer', workspacePath: root, instructions: 'review' }),
    { message: 'openclaw_agent_capability_profile_required' },
  );
  assert.equal(spawnCalls, 0);

  const shim = executable(root, 'openclaw-policy-shim.sh', `#!/bin/sh
printf '%s\n' "$@" > argv.txt
previous=''
for argument in "$@"; do
  if [ "$previous" = '--message-file' ]; then cp "$argument" observed-prompt.txt; fi
  previous="$argument"
done
env > child-env.txt
printf '%s\n' '{"result":{"payloads":[{"text":"{\\"status\\":\\"completed\\",\\"summary\\":\\"ok\\",\\"checksRun\\":[],\\"blockers\\":[]}"}]}}'
`);
  const priorSecret = process.env.HEPTA_AMBIENT_CREDENTIAL_FIXTURE;
  process.env.HEPTA_AMBIENT_CREDENTIAL_FIXTURE = 'must-not-reach-child';
  t.after(() => {
    if (priorSecret === undefined) delete process.env.HEPTA_AMBIENT_CREDENTIAL_FIXTURE;
    else process.env.HEPTA_AMBIENT_CREDENTIAL_FIXTURE = priorSecret;
  });
  const executor = createOpenClawAgentExecutor({
    openclawBinary: shim,
    agentId: 'fixture-agent',
    timeoutMs: 5000,
    ...openClawPolicy('fixture-agent', root),
  });
  const instruction = 'review private fixture without external actions';
  const receipt = await executor.execute({ role: 'reviewer', workspacePath: root, instructions: instruction });
  const argv = fs.readFileSync(path.join(root, 'argv.txt'), 'utf8');
  const prompt = fs.readFileSync(path.join(root, 'observed-prompt.txt'), 'utf8');
  const childEnvironment = fs.readFileSync(path.join(root, 'child-env.txt'), 'utf8');
  assert.ok(argv.includes('--message-file'));
  assert.equal(argv.includes(instruction), false);
  assert.ok(prompt.includes(instruction));
  assert.equal(childEnvironment.includes('HEPTA_AMBIENT_CREDENTIAL_FIXTURE'), false);
  assert.equal(receipt.externalActionPerformed, null);
  assert.equal(receipt.externalActionVerification, 'not_observed:openclaw_gateway_runtime_configuration_bound_pre_and_post');
});

test('OpenClaw production resolver reads the running local Gateway config.get snapshot', async (t) => {
  const root = temporary(t, 'hepta-openclaw-resolver-');
  const configuration = openClawRuntimeConfiguration('fixture-agent', root);
  const calls = [];
  const resolver = createOpenClawRuntimeConfigurationResolver({
    openclawBinary: '/fixture/openclaw',
    environment: { PATH: '/usr/bin' },
    spawnImpl(_executable, args) {
      calls.push(args);
      if (args[0] === 'gateway' && args[1] === 'probe') {
        return completedChildProcess(JSON.stringify({
          ok: true,
          degraded: false,
          primaryTargetId: 'localLoopback',
          targets: [{
            id: 'localLoopback',
            kind: 'localLoopback',
            url: configuration.gatewayUrl,
            connect: { rpcOk: true },
            self: { instanceId: configuration.gatewayInstanceId },
            config: { path: configuration.gatewayConfigPath },
          }],
        }));
      }
      return completedChildProcess(JSON.stringify(configuration.snapshot));
    },
  });
  const resolved = await resolver({ cwd: root });
  assert.equal(resolved.gatewayInstanceId, configuration.gatewayInstanceId);
  assert.equal(resolved.gatewayUrl, configuration.gatewayUrl);
  assert.equal(resolved.snapshot.hash, configuration.snapshot.hash);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ['gateway', 'probe', '--json'],
    ['gateway', 'call', 'config.get'],
  ]);
  assert.ok(calls[1].includes('--url'));
  assert.ok(calls[1].includes(configuration.gatewayUrl));
});

test('OpenClaw binds the approved profile to the actual Gateway configuration and exact workspace', async (t) => {
  const root = temporary(t, 'hepta-openclaw-binding-');
  const otherWorkspace = path.join(root, 'other');
  fs.mkdirSync(otherWorkspace);
  let spawnCalls = 0;
  const safe = openClawRuntimeConfiguration('fixture-agent', root);
  const driftedButStillRestricted = structuredClone(safe);
  driftedButStillRestricted.snapshot.runtimeConfig.agents.list[0].sandbox.docker.cpus = 1;
  rehashOpenClawRuntimeConfiguration(driftedButStillRestricted);
  const mismatched = createOpenClawAgentExecutor({
    agentId: 'fixture-agent',
    ...openClawPolicy('fixture-agent', root, 'workspace-write', safe, async () => driftedButStillRestricted),
    spawnImpl() { spawnCalls += 1; throw new Error('configuration mismatch must not spawn'); },
  });
  await assert.rejects(
    () => mismatched.execute({ role: 'writer', workspacePath: root, instructions: 'write' }),
    { message: 'openclaw_agent_configuration_hash_mismatch' },
  );

  const wrongWorkspaceConfiguration = openClawRuntimeConfiguration('fixture-agent', otherWorkspace);
  const wrongWorkspace = createOpenClawAgentExecutor({
    agentId: 'fixture-agent',
    ...openClawPolicy('fixture-agent', otherWorkspace, 'workspace-write', wrongWorkspaceConfiguration),
    spawnImpl() { spawnCalls += 1; throw new Error('unbound workspace must not spawn'); },
  });
  await assert.rejects(
    () => wrongWorkspace.execute({ role: 'writer', workspacePath: root, instructions: 'write' }),
    { message: 'openclaw_agent_dynamic_workspace_not_config_bound' },
  );
  assert.equal(spawnCalls, 0);
});

test('OpenClaw rejects a hash-bound Gateway agent whose real tool policy is wider than declared', async (t) => {
  const root = temporary(t, 'hepta-openclaw-wide-policy-');
  const wide = openClawRuntimeConfiguration('fixture-agent', root);
  wide.snapshot.runtimeConfig.agents.list[0].tools.alsoAllow = ['message'];
  rehashOpenClawRuntimeConfiguration(wide);
  let spawnCalls = 0;
  const executor = createOpenClawAgentExecutor({
    agentId: 'fixture-agent',
    ...openClawPolicy('fixture-agent', root, 'workspace-write', wide),
    spawnImpl() { spawnCalls += 1; throw new Error('wide policy must not spawn'); },
  });
  await assert.rejects(
    () => executor.execute({ role: 'writer', workspacePath: root, instructions: 'write' }),
    { message: 'openclaw_agent_configuration_tool_expansion_forbidden' },
  );
  assert.equal(spawnCalls, 0);
});

test('OpenClaw fails the completed turn when the Gateway configuration drifts during execution', async (t) => {
  const root = temporary(t, 'hepta-openclaw-config-drift-');
  const safe = openClawRuntimeConfiguration('fixture-agent', root);
  const drifted = structuredClone(safe);
  drifted.snapshot.runtimeConfig.agents.list[0].sandbox.docker.cpus = 1;
  rehashOpenClawRuntimeConfiguration(drifted);
  let resolutions = 0;
  const resolver = async () => {
    resolutions += 1;
    return resolutions === 1 ? safe : drifted;
  };
  const shim = executable(root, 'openclaw-drift-shim.sh', `#!/bin/sh
printf '%s\n' '{"result":{"payloads":[{"text":"{\\"status\\":\\"completed\\",\\"summary\\":\\"ok\\",\\"checksRun\\":[],\\"blockers\\":[]}"}]}}'
`);
  const executor = createOpenClawAgentExecutor({
    openclawBinary: shim,
    agentId: 'fixture-agent',
    ...openClawPolicy('fixture-agent', root, 'workspace-write', safe, resolver),
  });
  await assert.rejects(
    () => executor.execute({ role: 'writer', workspacePath: root, instructions: 'write' }),
    (error) => {
      assert.equal(error.message, 'openclaw_agent_configuration_drift_detected');
      assert.equal(error.receipt.status, 'agent_execution_failed');
      assert.equal(error.receipt.openClawConfigurationReverified, false);
      assert.equal(error.receipt.externalActionPerformed, null);
      assert.equal(error.receipt.externalActionVerification, 'not_observed:openclaw_gateway_runtime_configuration_not_reverified');
      return true;
    },
  );
  assert.equal(resolutions, 2);
});

test('Ollama receipt golden preserves structured edits and token accounting', async (t) => {
  const root = temporary(t, 'hepta-ollama-template-golden-');
  fs.writeFileSync(path.join(root, 'main.tex'), 'before\n');
  const structuredOutput = {
    status: 'completed',
    summary: 'ollama-ok',
    edits: [{ path: 'main.tex', content: 'after\n' }],
    checks: ['check-a'],
    blockers: [],
  };
  const stdout = JSON.stringify(structuredOutput);
  let providerRequest = null;
  const executor = createOllamaStructuredAgentExecutor({
    model: 'fixture-ollama',
    timeoutMs: 5000,
    maximumOutputTokens: 1024,
    fetchImpl: async (_url, options) => {
      providerRequest = JSON.parse(options.body);
      return { ok: true, json: async () => ({ response: stdout, done_reason: 'stop', eval_count: 17 }) };
    },
  });
  const receipt = await executor.execute({
    role: 'writer',
    workspacePath: root,
    instructions: 'edit the fixture',
    context: { campaignId: 'campaign-1' },
    requiredChecks: ['check-a'],
    outputTokenBudget: 444,
  });
  assert.equal(providerRequest.options.num_predict, 444);
  assert.equal(providerRequest.model, 'fixture-ollama');
  assert.deepEqual(verifyAndNormalizeReceipt(receipt), {
    version: 1,
    kind: 'AgentExecutionReceipt',
    executorId: 'ollama-structured-agent-v1',
    providerMode: 'local:ollama',
    model: 'fixture-ollama',
    resolvedModel: 'fixture-ollama',
    promptHash: '<prompt-hash>',
    sessionId: '<session-id>',
    childSessionId: '<session-id>',
    maximumOutputTokens: 444,
    outputTokenCount: 17,
    outputDoneReason: 'stop',
    role: 'writer',
    status: 'agent_execution_completed',
    changedPaths: ['main.tex'],
    summary: 'ollama-ok',
    structuredOutput,
    finalOutput: stdout,
    checksRun: ['check-a'],
    blockers: [],
    stdoutHash: sha256(stdout),
    stderrHash: sha256(''),
    stderrTail: '',
    stdoutTail: stdout,
    startedAt: '<started-at>',
    completedAt: '<completed-at>',
    externalActionPerformed: false,
    externalActionVerification: 'local_provider_without_agent_tools',
    agentExecutionReceiptHash: '<receipt-hash>',
  });
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'after\n');
});

test('shared preflight and workspace validation retain provider error codes', async (t) => {
  const root = temporary(t, 'hepta-agent-template-preflight-');
  const neverFetch = async () => { throw new Error('provider must not be invoked'); };
  const openclaw = createOpenClawAgentExecutor({ timeoutMs: 1000 });
  const codex = createCodexAgentExecutor({ timeoutMs: 1000 });
  const ollama = createOllamaStructuredAgentExecutor({ model: 'fixture', timeoutMs: 1000, maximumOutputTokens: 512, fetchImpl: neverFetch });
  await assert.rejects(
    () => openclaw.execute({ role: 'writer', workspacePath: root, instructions: 'write', sandbox: 'unsafe' }),
    { message: 'executor_sandbox_unsupported:unsafe' },
  );
  await assert.rejects(
    () => codex.execute({ role: 'writer', workspacePath: root, instructions: 'write', timeoutMs: 1001 }),
    { message: 'executor_timeout_limit_exceeded' },
  );
  await assert.rejects(
    () => ollama.execute({ role: 'writer', workspacePath: root, instructions: 'write', outputTokenBudget: 513 }),
    { message: 'executor_output_token_limit_exceeded' },
  );
  await assert.rejects(
    () => openclaw.execute({ role: 'writer', workspacePath: path.join(root, 'missing'), instructions: 'write' }),
    { message: 'agent role, existing workspacePath and instructions are required' },
  );
  await assert.rejects(
    () => ollama.execute({ role: 'writer', workspacePath: path.join(root, 'missing'), instructions: 'write' }),
    { message: 'role, instructions and workspacePath are required' },
  );
});

test('shared failure wrapping retains cancellation and read-only sandbox semantics', async (t) => {
  const root = temporary(t, 'hepta-agent-template-failure-');
  fs.writeFileSync(path.join(root, 'main.tex'), 'before\n');
  const controller = new AbortController();
  controller.abort('fixture-cancelled');
  let spawnCalls = 0;
  const codex = createCodexAgentExecutor({
    timeoutMs: 1000,
    spawnImpl() { spawnCalls += 1; throw new Error('pre-aborted execution must not spawn'); },
  });
  await assert.rejects(
    () => codex.execute({ role: 'writer', workspacePath: root, instructions: 'write', signal: controller.signal }),
    (error) => {
      assert.equal(error.message, 'codex_agent_cancelled');
      assert.equal(error.retryable, false);
      assert.deepEqual(error.receipt.blockers, ['codex_agent_cancelled']);
      assert.equal(error.receipt.status, 'agent_execution_failed');
      return true;
    },
  );
  assert.equal(spawnCalls, 0);

  const openclaw = createOpenClawAgentExecutor({
    timeoutMs: 1000,
    ...openClawPolicy('hepta-paper-worker', root),
    spawnImpl() { spawnCalls += 1; throw new Error('pre-aborted execution must not spawn'); },
  });
  await assert.rejects(
    () => openclaw.execute({ role: 'writer', workspacePath: root, instructions: 'write', signal: controller.signal }),
    (error) => {
      assert.equal(error.message, 'openclaw_agent_cancelled');
      assert.equal(error.retryable, false);
      assert.deepEqual(error.receipt.blockers, ['openclaw_agent_cancelled']);
      assert.equal(error.receipt.status, 'agent_execution_failed');
      return true;
    },
  );
  assert.equal(spawnCalls, 0);

  let fetchCalls = 0;
  const preAbortedOllama = createOllamaStructuredAgentExecutor({
    model: 'fixture',
    timeoutMs: 1000,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('pre-aborted execution must not fetch');
    },
  });
  await assert.rejects(
    () => preAbortedOllama.execute({ role: 'writer', workspacePath: root, instructions: 'write', signal: controller.signal }),
    (error) => {
      assert.equal(error.message, 'ollama_agent_cancelled');
      assert.equal(error.retryable, false);
      assert.deepEqual(error.receipt.blockers, ['ollama_agent_cancelled']);
      assert.equal(error.receipt.status, 'agent_execution_failed');
      return true;
    },
  );
  assert.equal(fetchCalls, 0);

  const ollama = createOllamaStructuredAgentExecutor({
    model: 'fixture',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        response: JSON.stringify({ status: 'completed', summary: 'invalid edit', edits: [{ path: 'main.tex', content: 'after\n' }], checks: [], blockers: [] }),
      }),
    }),
  });
  await assert.rejects(
    () => ollama.execute({ role: 'reviewer', workspacePath: root, instructions: 'review', sandbox: 'read-only' }),
    (error) => {
      assert.equal(error.message, 'read_only_agent_returned_edits');
      assert.equal(error.retryable, true);
      assert.deepEqual(error.receipt.changedPaths, []);
      assert.deepEqual(error.receipt.blockers, ['read_only_agent_returned_edits']);
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'before\n');
});

test('Codex and OpenClaw map mid-flight external cancellation without process-failure noise', async (t) => {
  const root = temporary(t, 'hepta-process-provider-template-abort-');
  const providers = [
    {
      name: 'Codex',
      blocker: 'codex_agent_cancelled',
      create(spawnImpl) { return createCodexAgentExecutor({ timeoutMs: 5000, spawnImpl }); },
    },
    {
      name: 'OpenClaw',
      blocker: 'openclaw_agent_cancelled',
      create(spawnImpl) { return createOpenClawAgentExecutor({ timeoutMs: 5000, spawnImpl, ...openClawPolicy('hepta-paper-worker', root) }); },
    },
  ];
  for (const provider of providers) {
    await t.test(provider.name, async () => {
      const controller = new AbortController();
      let spawnCalls = 0;
      const executor = provider.create(() => {
        spawnCalls += 1;
        return cancellableChildProcess();
      });
      const pending = executor.execute({ role: 'writer', workspacePath: root, instructions: 'write', signal: controller.signal });
      for (let attempt = 0; attempt < 10 && spawnCalls === 0; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(spawnCalls, 1);
      controller.abort('operator-cancelled');
      await assert.rejects(
        () => pending,
        (error) => {
          assert.equal(error.message, provider.blocker);
          assert.equal(error.retryable, false);
          assert.deepEqual(error.receipt.blockers, [provider.blocker]);
          return true;
        },
      );
    });
  }
});

test('Ollama maps a mid-flight AbortError to non-retryable cancellation', async (t) => {
  const root = temporary(t, 'hepta-ollama-template-abort-');
  const controller = new AbortController();
  let providerSignal = null;
  const executor = createOllamaStructuredAgentExecutor({
    model: 'fixture',
    timeoutMs: 5000,
    fetchImpl: async (_url, options) => {
      providerSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('fixture-aborted', 'AbortError')), { once: true });
      });
    },
  });
  const pending = executor.execute({ role: 'writer', workspacePath: root, instructions: 'write', signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort('operator-cancelled');
  await assert.rejects(
    () => pending,
    (error) => {
      assert.equal(error.message, 'ollama_agent_cancelled');
      assert.equal(error.retryable, false);
      assert.deepEqual(error.receipt.blockers, ['ollama_agent_cancelled']);
      return true;
    },
  );
  assert.equal(providerSignal.aborted, true);
});

test('Ollama timeout remains a retryable provider failure rather than external cancellation', async (t) => {
  const root = temporary(t, 'hepta-ollama-template-timeout-');
  const executor = createOllamaStructuredAgentExecutor({
    model: 'fixture',
    timeoutMs: 20,
    fetchImpl: async (_url, options) => await new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  await assert.rejects(
    () => executor.execute({ role: 'writer', workspacePath: root, instructions: 'write' }),
    (error) => {
      assert.equal(error.message, 'ollama_agent_process_failed,ollama_agent_invalid_json');
      assert.equal(error.retryable, true);
      assert.deepEqual(error.receipt.blockers, ['ollama_agent_process_failed', 'ollama_agent_invalid_json']);
      return true;
    },
  );
});

test('Ollama structured edits reject symlink parents and symlink targets without external writes', async (t) => {
  const root = temporary(t, 'hepta-ollama-scoped-edit-');
  const outsideDirectory = path.join(root, 'outside-directory');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(outsideDirectory);
  fs.mkdirSync(workspace);
  fs.symlinkSync(outsideDirectory, path.join(workspace, 'linked'));
  let edit = { path: 'linked/pwned.txt', content: 'pwned\n' };
  const executor = createOllamaStructuredAgentExecutor({
    model: 'fixture',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        response: JSON.stringify({ status: 'completed', summary: 'edit', edits: [edit], checks: [], blockers: [] }),
      }),
    }),
  });
  await assert.rejects(
    () => executor.execute({ role: 'writer', workspacePath: workspace, instructions: 'edit' }),
    (error) => error.message === 'ollama_agent_edit_path_or_content_invalid'
      && error.receipt?.blockers?.includes('ollama_agent_edit_path_or_content_invalid'),
  );
  assert.equal(fs.existsSync(path.join(outsideDirectory, 'pwned.txt')), false);

  const outsideFile = path.join(root, 'outside.txt');
  fs.writeFileSync(outsideFile, 'outside\n');
  fs.symlinkSync(outsideFile, path.join(workspace, 'target.txt'));
  edit = { path: 'target.txt', content: 'replaced\n' };
  await assert.rejects(
    () => executor.execute({ role: 'writer', workspacePath: workspace, instructions: 'edit' }),
    (error) => error.message === 'ollama_agent_edit_path_or_content_invalid'
      && error.receipt?.changedPaths?.length === 0,
  );
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside\n');
});
