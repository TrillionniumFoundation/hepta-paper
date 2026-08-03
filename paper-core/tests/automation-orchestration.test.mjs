import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOpenClawAgentExecutor, openClawAgentCapabilityProfileHash } from '../../paper-adapters/automation/openclaw-agent-executor.mjs';
import { openClawAgentConfigurationHash, openClawGatewayConfigurationHash } from '../../paper-adapters/automation/openclaw-agent-configuration.mjs';
import { createAgentBackendRouter } from '../../paper-adapters/automation/agent-backend-router.mjs';
import {
  buildAgentBackendUsageReceipt,
  buildAgentExecutionUsageBinding,
  buildAgentPostprocessingFailureUsageReceipt,
  normalizeAgentExecutionUsage,
  verifyAgentBackendUsageReceipt,
  verifyAgentExecutionReceipt,
  verifyAgentExecutionUsageBinding,
  verifyAgentPostprocessingFailureUsageReceipt,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import { runManuscriptQualityChecks } from '../../paper-adapters/automation/manuscript-quality-checks.mjs';
import {
  executeCampaignQualityRevalidationNode,
} from '../../paper-application/automation/campaign-quality-release-orchestrator.mjs';
import {
  executeCampaignAgentNode,
  selectTrustedAutonomousManuscriptAuthorshipReceipt,
} from '../../paper-application/automation/campaign-agent-node-orchestrator.mjs';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import {
  meteredCampaignResultUsage,
} from '../../paper-application/automation/campaign-execution-budget-policy.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createTheoremQualityRevisionSink } from '../../paper-adapters/automation/theorem-quality-revision-sink.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  genericManuscriptReleaseFixture,
} from './support/autonomous-research-generalization-fixture.mjs';

function fixtureCapabilities(executorId, overrides = {}) {
  return () => buildExecutorCapabilities({
    executorId,
    sandboxModes: ['read-only', 'workspace-write'],
    networkPolicy: 'none',
    receiptKinds: ['AgentExecutionReceipt'],
    ...overrides,
  });
}

function fixtureAgentReceipt(executorId, changedPaths, extra = {}) {
  const payload = {
    status: 'agent_execution_completed',
    executorId,
    changedPaths: Object.freeze([...changedPaths].sort()),
    externalModelInvocationPerformed: false,
    usage: Object.freeze({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    }),
    ...extra,
  };
  return Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
}

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('trusted manuscript result projects the receipt selected by rendering', () => {
  const currentReceipt = fixtureAgentReceipt('current-reviser', []);
  const priorAuthorshipReceipt = fixtureAgentReceipt(
    'prior-author',
    ['AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'],
  );
  assert.equal(selectTrustedAutonomousManuscriptAuthorshipReceipt({
    renderReceipt: {
      agentAuthoredRenderedProseReceiptHash:
        priorAuthorshipReceipt.agentExecutionReceiptHash,
    },
    agentExecutionReceipts: [currentReceipt, priorAuthorshipReceipt],
  }), priorAuthorshipReceipt);
  assert.throws(
    () => selectTrustedAutonomousManuscriptAuthorshipReceipt({
      renderReceipt: { agentAuthoredRenderedProseReceiptHash: hashRecord('Missing', {}) },
      agentExecutionReceipts: [currentReceipt],
    }),
    /trusted_autonomous_manuscript_authorship_receipt_projection_invalid/,
  );
});

test('revision result retains prior authorship proof when the current agent makes no draft edit', async () => {
  const paperId = 'paper-authorship-projection';
  const campaignId = 'campaign-authorship-projection';
  const release = genericManuscriptReleaseFixture({ paperId, campaignId });
  const currentReceipt = fixtureAgentReceipt('current-reviser', []);
  const priorAuthorshipReceipt = fixtureAgentReceipt(
    'prior-author',
    ['AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'],
  );
  const result = await executeCampaignAgentNode({
    primitives: {
      agent: { async execute() { return currentReceipt; } },
      workspace: {
        prepareEmpiricalAssertionAuthority() { return {}; },
        prepareAutonomousManuscriptEvidenceRefBindings() { return null; },
        renderTrustedAutonomousManuscript() {
          return {
            agentAuthoredRenderedProseReceiptHash:
              priorAuthorshipReceipt.agentExecutionReceiptHash,
            trustedAutonomousManuscriptRenderReceiptHash:
              hashRecord('TrustedRenderReceipt', { campaignId }),
            manuscriptIrPath: 'AUTONOMOUS_MANUSCRIPT_IR.json',
            evidenceEntailmentContractPath: 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json',
            presentationArtifacts: [],
          };
        },
      },
    },
    campaign: {
      campaignId,
      paperId,
      spec: {
        autonomousResearchPreparation: release.preparation,
        scientificClaimAuthority: { claimAuthorityType: 'machine-policy-authorized' },
        paperQualityProfiles: [],
        datasetMounts: [],
        languages: ['latex'],
      },
    },
    node: { nodeId: '1:revise', kind: 'revise', role: 'writer', roundIndex: 1 },
    context: {
      campaignNodes: [{
        kind: 'manuscript-integrate',
        status: 'completed',
        result: { agentExecutionReceipt: priorAuthorshipReceipt },
      }],
      reviews: [],
      qualityGateBlockers: [],
    },
    workspace: '/tmp',
    manuscript: 'main.tex',
    executionBudget: { remainingTokenCount: 1000, remainingWallTimeMs: 1000 },
  });
  assert.equal(result.agentExecutionReceiptHash, currentReceipt.agentExecutionReceiptHash);
  assert.equal(result.agentExecutionReceipt, currentReceipt);
  assert.equal(
    result.authorshipAgentExecutionReceiptHash,
    priorAuthorshipReceipt.agentExecutionReceiptHash,
  );
  assert.equal(result.authorshipAgentExecutionReceipt, priorAuthorshipReceipt);
  assert.deepEqual(result.changedPaths, [
    'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json',
    'AUTONOMOUS_MANUSCRIPT_IR.json',
    'main.tex',
  ]);
});

function openClawPolicy(agentId = 'fixture', workspace = process.cwd()) {
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
          workspaceAccess: 'rw',
          docker: {
            network: 'none', readOnlyRoot: true, capDrop: ['ALL'], binds: [], env: {},
            pidsLimit: 64, memory: '1g', memorySwap: '1g', cpus: 2, user: '1000:1000',
          },
          browser: { enabled: false, allowHostControl: false, binds: [] },
        },
        tools: {
          allow: ['apply_patch', 'edit', 'exec', 'process', 'read', 'write'],
          elevated: { enabled: false },
          fs: { workspaceOnly: true },
          exec: {
            host: 'sandbox', mode: 'allowlist', security: 'allowlist', ask: 'off', strictInlineEval: true,
            pathPrepend: [], safeBins: [], safeBinTrustedDirs: [], safeBinProfiles: {},
            applyPatch: { workspaceOnly: true },
          },
          sandbox: { tools: { allow: ['apply_patch', 'edit', 'exec', 'process', 'read', 'write'] } },
          subagents: { tools: { allow: [] } },
        },
      }],
    },
    tools: {},
  };
  const resolvedConfiguration = {
    gatewayInstanceId: 'fixture-gateway-instance',
    gatewayUrl: 'ws://127.0.0.1:18789',
    snapshot: {
      valid: true,
      hash: crypto.createHash('sha256').update(JSON.stringify(runtimeConfig)).digest('hex'),
      runtimeConfig,
    },
  };
  const agentCapabilityProfile = Object.freeze({
    version: 2,
    kind: 'OpenClawAgentCapabilityProfile',
    agentId,
    enforcement: 'openclaw-gateway-runtime-configuration',
    delivery: 'disabled',
    toolPolicy: Object.freeze({ messaging: 'denied', externalMutation: 'denied', credentialAccess: 'denied' }),
    openClawAgentConfigurationHash: openClawAgentConfigurationHash(resolvedConfiguration, agentId),
    openClawGatewayConfigurationHash: openClawGatewayConfigurationHash(resolvedConfiguration, agentId),
  });
  return {
    agentCapabilityProfile,
    expectedAgentCapabilityProfileHash: openClawAgentCapabilityProfileHash(agentCapabilityProfile),
    openClawConfigurationResolver: async () => resolvedConfiguration,
  };
}

test('OpenClaw executor uses an isolated session key and captures usage and changes', async (t) => {
  const root = temporary(t, 'hepta-openclaw-executor-');
  fs.writeFileSync(path.join(root, 'main.tex'), 'before\n');
  const shim = path.join(root, 'openclaw-shim.sh');
  fs.writeFileSync(shim, `#!/bin/sh
printf 'after\\n' > main.tex
printf '%s\\n' '{"runId":"run","status":"ok","result":{"payloads":[{"text":"{\\"status\\":\\"completed\\",\\"summary\\":\\"ok\\",\\"checksRun\\":[],\\"blockers\\":[]}"}],"meta":{"agentMeta":{"sessionId":"child-session","usage":{"input":10,"output":2,"total":12}}}}}'
`);
  fs.chmodSync(shim, 0o755);
  const executor = createOpenClawAgentExecutor({ openclawBinary: shim, agentId: 'fixture', timeoutMs: 5000, ...openClawPolicy('fixture', root) });
  const receipt = await executor.execute({ role: 'writer', workspacePath: root, instructions: 'edit', context: { campaignId: 'c', nodeId: 'n' } });
  assert.equal(receipt.status, 'agent_execution_completed');
  assert.equal(receipt.sessionId, 'child-session');
  assert.equal(receipt.childSessionId, 'child-session');
  assert.equal(receipt.usage.total, 12);
  assert.deepEqual(receipt.changedPaths, ['main.tex']);
  assert.equal(receipt.structuredOutput.summary, 'ok');
});

test('isolated executor merges non-conflicting changes and backend router falls back', async (t) => {
  const root = temporary(t, 'hepta-isolated-executor-');
  const isolation = path.join(root, 'isolated');
  const paper = path.join(root, 'paper');
  fs.mkdirSync(paper);
  fs.writeFileSync(path.join(paper, 'main.tex'), 'before\n');
  const fallback = { executorId: 'fallback', capabilities: fixtureCapabilities('fallback'), async execute(input) { fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'after\n'); fs.writeFileSync(path.join(input.workspacePath, 'NEW.md'), 'new\n'); fs.mkdirSync(path.join(input.workspacePath, '__pycache__')); fs.writeFileSync(path.join(input.workspacePath, '__pycache__', 'generated.pyc'), 'cache'); return fixtureAgentReceipt('fallback', ['main.tex', 'NEW.md']); } };
  const router = createAgentBackendRouter({ primary: { executorId: 'primary', capabilities: fixtureCapabilities('primary'), async execute() { const error = new Error('offline'); error.retryable = true; error.receipt = fixtureAgentReceipt('primary', [], { status: 'agent_execution_failed' }); throw error; } }, fallbacks: [fallback] });
  const executor = createIsolatedAgentExecutor({ delegate: router, isolationRoot: isolation, keepWorkspaces: false });
  const receipt = await executor.execute({ role: 'writer', workspacePath: paper, instructions: 'edit', context: { campaignId: 'c', nodeId: 'n' } });
  assert.equal(receipt.selectedExecutorId, 'fallback');
  assert.equal(receipt.fallbackCount, 1);
  assert.equal(fs.readFileSync(path.join(paper, 'main.tex'), 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(path.join(paper, 'NEW.md'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(path.join(paper, '__pycache__')), false);
});

test('backend router preserves a terminal executor failure without fallback', async () => {
  let fallbackCalls = 0;
  const primary = {
    executorId: 'terminal-primary',
    capabilities: fixtureCapabilities('terminal-primary'),
    async execute() {
      const error = new Error('managed_snapshot_policy_failed');
      error.retryable = false;
      throw error;
    },
  };
  const fallback = {
    executorId: 'unused-fallback',
    capabilities: fixtureCapabilities('unused-fallback'),
    async execute() {
      fallbackCalls += 1;
      return fixtureAgentReceipt('unused-fallback', []);
    },
  };
  const router = createAgentBackendRouter({ primary, fallbacks: [fallback] });
  await assert.rejects(
    () => router.execute({
      role: 'writer',
      workspacePath: process.cwd(),
      instructions: 'do not execute the fallback',
    }),
    (error) => {
      assert.equal(error.retryable, false);
      assert.equal(error.failures.length, 1);
      assert.equal(error.failures[0].message, 'managed_snapshot_policy_failed');
      return true;
    },
  );
  assert.equal(fallbackCalls, 0);
});

test('backend router aggregates hash-verified failed and selected usage', async () => {
  const failedReceipt = fixtureAgentReceipt('usage-primary', [], {
    status: 'agent_execution_failed',
    usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
  });
  const selectedReceipt = fixtureAgentReceipt('usage-fallback', [], {
    usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7 },
  });
  const primary = {
    executorId: 'usage-primary',
    capabilities: fixtureCapabilities('usage-primary'),
    async execute() {
      const error = new Error('retryable_primary_failure');
      error.retryable = true;
      error.receipt = failedReceipt;
      throw error;
    },
  };
  const fallback = {
    executorId: 'usage-fallback',
    capabilities: fixtureCapabilities('usage-fallback'),
    async execute() { return selectedReceipt; },
  };
  const result = await createAgentBackendRouter({ primary, fallbacks: [fallback] })
    .execute({ role: 'writer', workspacePath: process.cwd(), instructions: 'usage' });
  assert.equal(verifyAgentExecutionReceipt(result), true);
  assert.deepEqual(result.agentBackendUsage, {
    cacheRead: 1,
    cacheWrite: 0,
    input: 6,
    output: 3,
    totalTokens: 10,
  });
  assert.equal(verifyAgentBackendUsageReceipt(result.agentBackendUsageReceipt, {
    selectedAgentExecutionReceiptHash: selectedReceipt.agentExecutionReceiptHash,
  }), true);
  assert.equal(meteredCampaignResultUsage(result, {
    agentCall: true,
  }).tokens, 10);
  const usageBinding = buildAgentExecutionUsageBinding(result);
  assert.equal(verifyAgentExecutionUsageBinding(usageBinding, {
    agentExecutionReceipt: result,
  }), true);
  assert.equal(meteredCampaignResultUsage({
    agentExecutionReceipt: result,
    usage: usageBinding.usage,
    outputTokenCount: 1,
    agentExecutionUsageBindingHash:
      usageBinding.agentExecutionUsageBindingHash,
    agentExecutionUsageBinding: usageBinding,
  }, { agentCall: true }).tokens, 10);
  const postprocessing = buildAgentPostprocessingFailureUsageReceipt(result);
  assert.equal(postprocessing.usage.totalTokens, 10);
  assert.equal(meteredCampaignResultUsage(postprocessing, {
    agentCall: true, failureReceipt: true,
  }).tokens, 10);
  const unverifiedFailure = meteredCampaignResultUsage({
    usage: { totalTokens: 999 },
  }, {
    agentCall: true, failureReceipt: true,
  });
  assert.equal(unverifiedFailure.tokens, 0);
  assert.equal(unverifiedFailure.agentUsageComplete, false);
  assert.equal(unverifiedFailure.agentUsageStatus, 'agent_usage_unknown_terminal');
  const tampered = structuredClone(result.agentBackendUsageReceipt);
  tampered.usage.totalTokens = 9;
  assert.equal(verifyAgentBackendUsageReceipt(tampered), false);
  const suppressed = structuredClone(result.agentBackendUsageReceipt);
  suppressed.attempts[0].usageReported = false;
  suppressed.attempts[0].usage = null;
  suppressed.attempts[0].usageHash = null;
  const { agentBackendUsageReceiptHash: _suppressedHash, ...suppressedPayload } = suppressed;
  suppressed.agentBackendUsageReceiptHash = hashRecord(
    'AgentBackendUsageReceipt', suppressedPayload,
  );
  assert.equal(verifyAgentBackendUsageReceipt(suppressed), false);
  assert.throws(() => meteredCampaignResultUsage({
    ...result,
    agentBackendUsageReceipt: suppressed,
    agentBackendUsageReceiptHash: suppressed.agentBackendUsageReceiptHash,
  }, { agentCall: true }), /agent_execution_usage_binding_invalid/);
});

test('usage bindings require their verified source receipt and cannot self-authenticate', () => {
  const receipt = fixtureAgentReceipt('binding-source', [], {
    externalModelInvocationPerformed: true,
    usage: {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costUsd: 0.25,
    },
  });
  const binding = buildAgentExecutionUsageBinding(receipt);
  assert.equal(verifyAgentExecutionUsageBinding(binding), false);
  assert.equal(verifyAgentExecutionUsageBinding(binding, {
    agentExecutionReceipt: receipt,
  }), true);
  assert.throws(() => meteredCampaignResultUsage({
    usage: binding.usage,
    agentExecutionUsageBinding: binding,
    agentExecutionUsageBindingHash: binding.agentExecutionUsageBindingHash,
  }, { agentCall: true }), /agent_execution_usage_binding_invalid/);
  assert.deepEqual(meteredCampaignResultUsage({
    agentExecutionReceipt: receipt,
    usage: binding.usage,
    agentExecutionUsageBinding: binding,
    agentExecutionUsageBindingHash: binding.agentExecutionUsageBindingHash,
  }, { agentCall: true }), { tokens: 3, costUsd: 0.25, pricedAgentCalls: 1 });
  const tamperedCost = structuredClone(receipt);
  tamperedCost.usage.costUsd = 0.5;
  assert.throws(() => meteredCampaignResultUsage(tamperedCost, {
    agentCall: true,
  }), /agent_execution_usage_binding_invalid/);
  const invalidCost = fixtureAgentReceipt('binding-negative-cost', [], {
    externalModelInvocationPerformed: true,
    usage: {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costUsd: -1,
    },
  });
  assert.equal(buildAgentExecutionUsageBinding(invalidCost), null);
  assert.throws(() => meteredCampaignResultUsage(invalidCost, {
    agentCall: true,
  }), /agent_execution_usage_binding_invalid/);
});

test('workspace integration metadata remains outside the agent receipt hash domain', () => {
  const receipt = fixtureAgentReceipt('workspace-isolated-usage', ['RESEARCH_PLAN.md'], {
    externalModelInvocationPerformed: true,
    usage: {
      input: 25_026,
      output: 1_124,
      cacheRead: 7_936,
      cacheWrite: 0,
      totalTokens: 34_086,
    },
  });
  const isolatedResult = {
    ...receipt,
    workspaceAttemptIntegration: {
      version: 2,
      kind: 'WorkspaceAttemptIntegrationDescriptor',
      workspaceAttemptIntegrationDescriptorHash:
        `sha256:${'a'.repeat(64)}`,
    },
  };
  assert.equal(verifyAgentExecutionReceipt(isolatedResult), true);
  const binding = buildAgentExecutionUsageBinding(isolatedResult);
  assert.equal(verifyAgentExecutionUsageBinding(binding, {
    agentExecutionReceipt: isolatedResult,
  }), true);
  assert.equal(meteredCampaignResultUsage(isolatedResult, {
    agentCall: true,
  }).tokens, 34_086);

  const tampered = structuredClone(isolatedResult);
  tampered.usage.totalTokens = 34_087;
  assert.equal(verifyAgentExecutionReceipt(tampered), false);
  assert.throws(() => meteredCampaignResultUsage(tampered, {
    agentCall: true,
  }), /agent_execution_usage_binding_invalid/);
});

test('backend usage receipts reject replayed attempts and executor mismatches', () => {
  const first = fixtureAgentReceipt('identity-a', [], {
    externalModelInvocationPerformed: true,
    usage: {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    },
  });
  const second = fixtureAgentReceipt('identity-b', [], {
    externalModelInvocationPerformed: true,
    usage: {
      input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
    },
  });
  const replayed = buildAgentBackendUsageReceipt({
    attempts: [
      { attemptId: 'attempt-a', executorId: 'identity-a', receipt: first },
      { attemptId: 'attempt-b', executorId: 'identity-a', receipt: first },
    ],
    status: 'all_agent_backends_failed',
  });
  assert.equal(replayed.usageComplete, false);
  assert.equal(verifyAgentBackendUsageReceipt(replayed), false);

  const duplicateAttemptId = buildAgentBackendUsageReceipt({
    attempts: [
      { attemptId: 'duplicate', executorId: 'identity-a', receipt: first },
      { attemptId: 'duplicate', executorId: 'identity-b', receipt: second },
    ],
    status: 'all_agent_backends_failed',
  });
  assert.equal(verifyAgentBackendUsageReceipt(duplicateAttemptId), false);

  const mismatchedExecutor = buildAgentBackendUsageReceipt({
    attempts: [{
      attemptId: 'mismatch', executorId: 'identity-b', receipt: first,
    }],
    status: 'all_agent_backends_failed',
  });
  assert.equal(mismatchedExecutor.usageComplete, false);
  assert.equal(verifyAgentBackendUsageReceipt(mismatchedExecutor), false);
});

test('incomplete backend usage is a terminal unknown with a metered known lower bound', () => {
  assert.deepEqual(meteredCampaignResultUsage(undefined, {
    agentCall: true, failureReceipt: true,
  }), {
    tokens: 0,
    agentUsageComplete: false,
    agentUsageStatus: 'agent_usage_unknown_terminal',
    agentUsageReason: 'agent_failure_usage_receipt_missing',
    agentUsageReceiptHash: null,
  });
  const known = fixtureAgentReceipt('known-attempt', [], {
    status: 'agent_execution_failed',
    externalModelInvocationPerformed: true,
    usage: {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    },
  });
  const incomplete = buildAgentBackendUsageReceipt({
    attempts: [
      { attemptId: 'known', executorId: 'known-attempt', receipt: known },
      { attemptId: 'unknown', executorId: 'unknown-attempt', receipt: null },
    ],
    status: 'all_agent_backends_failed',
  });
  assert.equal(verifyAgentBackendUsageReceipt(incomplete), true);
  assert.equal(incomplete.usageComplete, false);
  const metered = meteredCampaignResultUsage(incomplete, {
    agentCall: true, failureReceipt: true,
  });
  assert.deepEqual(metered, {
    tokens: 3,
    agentUsageComplete: false,
    agentUsageStatus: 'agent_usage_unknown_terminal',
    agentUsageReason: 'agent_backend_usage_incomplete',
    agentUsageReceiptHash: incomplete.agentBackendUsageReceiptHash,
  });

  const knownLowerBoundPayload = {
    status: 'agent_execution_failed',
    executorId: 'managed-usage-invalid',
    externalModelInvocationPerformed: true,
    usageComplete: false,
    usage: {
      input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
    },
  };
  const knownLowerBound = {
    ...knownLowerBoundPayload,
    agentExecutionReceiptHash: hashRecord(
      'AgentExecutionReceipt', knownLowerBoundPayload,
    ),
  };
  const directMetered = meteredCampaignResultUsage(knownLowerBound, {
    agentCall: true, failureReceipt: true,
  });
  assert.equal(directMetered.tokens, 6);
  assert.equal(directMetered.agentUsageComplete, false);
});

test('outcome-bound mutation rejection preserves successful agent usage evidence', async () => {
  const paperId = 'paper-generalized-1';
  const campaignId = 'campaign-generalized-1';
  const release = genericManuscriptReleaseFixture({ paperId, campaignId });
  const receipt = fixtureAgentReceipt('outcome-bound-writer', [
    'experiments/run.py',
  ], {
    externalModelInvocationPerformed: true,
    finalOutput: '{}',
    usage: {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    },
  });
  await assert.rejects(() => executeCampaignAgentNode({
    primitives: {
      agent: { async execute() { return receipt; } },
      workspace: { prepareEmpiricalAssertionAuthority() { return {}; } },
    },
    campaign: {
      campaignId,
      paperId,
      spec: {
        autonomousResearchPreparation: release.preparation,
        paperQualityProfiles: ['empirical_or_experiment'],
        datasetMounts: [],
        languages: ['latex'],
      },
    },
    node: {
      nodeId: 'revise', kind: 'revise', role: 'writer', roundIndex: 1,
    },
    context: {
      campaignNodes: [{ kind: 'empirical', status: 'completed' }],
      reviews: [],
      qualityGateBlockers: [],
    },
    workspace: '/tmp',
    manuscript: 'main.tex',
    executionBudget: { remainingTokenCount: 1000, remainingWallTimeMs: 1000 },
  }), (error) => {
    assert.equal(
      error.message,
      'campaign_outcome_informed_empirical_mutation_forbidden:experiments/run.py',
    );
    assert.equal(verifyAgentPostprocessingFailureUsageReceipt(error.receipt), true);
    assert.equal(error.postprocessingReceipt.invalidPath, 'experiments/run.py');
    assert.equal(meteredCampaignResultUsage(error.receipt, {
      agentCall: true, failureReceipt: true,
    }).tokens, 3);
    return true;
  });
});

test('agent usage rejects conflicting or null aliases while tolerating undefined aliases', () => {
  assert.equal(normalizeAgentExecutionUsage({
    input: 1,
    inputTokens: 1000,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
  }), null);
  assert.equal(normalizeAgentExecutionUsage({
    input: null,
    inputTokens: 1,
    output: 1,
    totalTokens: 2,
  }), null);
  assert.deepEqual(normalizeAgentExecutionUsage({
    input: 1,
    inputTokens: undefined,
    output: 1,
    output_tokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    total: 2,
    totalTokens: undefined,
  }), {
    cacheRead: 0,
    cacheWrite: 0,
    input: 1,
    output: 1,
    totalTokens: 2,
  });
});

test('failure metering ignores output-only counts when verified full agent usage is absent', () => {
  const receipt = fixtureAgentReceipt('legacy-output-only-failure', [], {
    status: 'agent_execution_failed',
    externalModelInvocationPerformed: true,
    usage: undefined,
    outputTokenCount: 1,
  });
  assert.equal(verifyAgentExecutionReceipt(receipt, { requireCompleted: false }), true);
  assert.equal(meteredCampaignResultUsage(receipt, {
    agentCall: true, failureReceipt: true,
  }).tokens, 0);
});

test('backend router fails closed on a verified external model receipt without usage', async () => {
  const executor = {
    executorId: 'missing-usage-model',
    capabilities: fixtureCapabilities('missing-usage-model'),
    async execute() {
      return fixtureAgentReceipt('missing-usage-model', [], {
        externalModelInvocationPerformed: true,
        usage: undefined,
      });
    },
  };
  await assert.rejects(
    () => createAgentBackendRouter({ primary: executor }).execute({
      role: 'writer', workspacePath: process.cwd(), instructions: 'missing usage',
    }),
    (error) => error.retryable === false
      && error.receipt?.usageComplete === false
      && error.receipt?.attempts?.[0]?.usageRequired === true
      && error.receipt?.attempts?.[0]?.usageReported === false,
  );
});

test('usage binding permits missing usage only for an explicit non-model execution', () => {
  const unknownPayload = {
    status: 'agent_execution_completed',
    executorId: 'unknown-model-status',
    changedPaths: [],
  };
  const unknown = {
    ...unknownPayload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', unknownPayload),
  };
  assert.equal(buildAgentExecutionUsageBinding(unknown), null);
  const nonModel = fixtureAgentReceipt('explicit-non-model', [], { usage: undefined });
  assert.equal(buildAgentExecutionUsageBinding(nonModel)?.usage, null);
});

test('backend router attaches aggregate verified usage when every backend fails', async () => {
  const failing = (executorId, usage, retryable) => ({
    executorId,
    capabilities: fixtureCapabilities(executorId),
    async execute() {
      const receipt = fixtureAgentReceipt(executorId, [], {
        status: 'agent_execution_failed', usage,
      });
      const error = new Error(`${executorId}_failed`);
      error.retryable = retryable;
      error.receipt = receipt;
      throw error;
    },
  });
  const router = createAgentBackendRouter({
    primary: failing('failure-a', {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    }, true),
    fallbacks: [failing('failure-b', {
      input: 3, output: 2, cacheRead: 1, cacheWrite: 1, totalTokens: 7,
    }, false)],
  });
  await assert.rejects(
    () => router.execute({
      role: 'writer', workspacePath: process.cwd(), instructions: 'all fail',
    }),
    (error) => {
      assert.equal(error.retryable, false);
      assert.equal(error.receipt.status, 'all_agent_backends_failed');
      assert.deepEqual(error.receipt.usage, {
        cacheRead: 1,
        cacheWrite: 1,
        input: 5,
        output: 3,
        totalTokens: 10,
      });
      assert.equal(verifyAgentBackendUsageReceipt(error.receipt), true);
      assert.equal(meteredCampaignResultUsage(error.receipt, {
        agentCall: true, failureReceipt: true,
      }).tokens, 10);
      return true;
    },
  );
});

test('isolated executor keeps nested operation identity separate from persisted campaign node identity', async (t) => {
  const root = temporary(t, 'hepta-isolated-nested-node-');
  const paper = path.join(root, 'paper');
  fs.mkdirSync(paper);
  fs.writeFileSync(path.join(paper, 'main.tex'), 'before\n');
  const registrations = [];
  const workspaceRegistry = {
    register(entry) {
      registrations.push(entry);
      return { ...entry, status: 'active' };
    },
    transition() {},
  };
  const delegate = {
    executorId: 'nested-formal-delegate',
    capabilities: fixtureCapabilities('nested-formal-delegate'),
    async execute() {
      return fixtureAgentReceipt('nested-formal-delegate', []);
    },
  };
  const executor = createIsolatedAgentExecutor({
    delegate,
    isolationRoot: path.join(root, 'isolated'),
    workspaceRegistry,
    keepWorkspaces: false,
  });
  await executor.execute({
    role: 'formal-author',
    workspacePath: paper,
    instructions: 'verify',
    context: {
      campaignId: 'campaign-1',
      nodeId: 'persisted-formal-verify-node',
      operationNodeId: 'persisted-formal-verify-node:formal-author:0',
    },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].nodeId, 'persisted-formal-verify-node');
  assert.match(registrations[0].workspaceId, /formal-author_0/);
});

test('isolated agents cannot mint system-owned automation result artifacts', async (t) => {
  const root = temporary(t, 'hepta-system-owned-results-');
  const paper = path.join(root, 'paper');
  fs.mkdirSync(paper);
  fs.writeFileSync(path.join(paper, 'main.tex'), 'before\n');
  const delegate = {
    executorId: 'result-minting-delegate',
    capabilities: fixtureCapabilities('result-minting-delegate'),
    async execute(input) {
      fs.mkdirSync(path.join(input.workspacePath, 'automation-results'));
      fs.writeFileSync(path.join(input.workspacePath, 'automation-results', 'results.json'), '{"score":1}\n');
      return { status: 'agent_execution_completed', agentExecutionReceiptHash: 'sha256:result-mint' };
    },
  };
  const isolated = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated') });
  await assert.rejects(
    isolated.execute({ role: 'writer', workspacePath: paper, instructions: 'mint result' }),
    (error) => error.retryable === false
      && error.message === 'workspace_mutation_system_owned:automation-results/results.json',
  );
  assert.equal(fs.existsSync(path.join(paper, 'automation-results')), false);
});

test('OpenClaw timeout with unknown usage fails closed while isolated workspaces reject symlinks', async (t) => {
  const root = temporary(t, 'hepta-openclaw-timeout-');
  const paper = path.join(root, 'paper');
  fs.mkdirSync(paper);
  fs.writeFileSync(path.join(paper, 'main.tex'), 'before\n');
  const slow = path.join(root, 'slow.sh');
  fs.writeFileSync(slow, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(slow, 0o755);
  const primary = createOpenClawAgentExecutor({ openclawBinary: slow, agentId: 'fixture', timeoutMs: 25, ...openClawPolicy('fixture', paper) });
  const fallback = { executorId: 'fallback-after-timeout', capabilities: fixtureCapabilities('fallback-after-timeout'), async execute() { return { status: 'agent_execution_completed', changedPaths: [], agentExecutionReceiptHash: 'sha256:fallback-timeout' }; } };
  await assert.rejects(
    () => createAgentBackendRouter({ primary, fallbacks: [fallback] }).execute({ role: 'writer', workspacePath: paper, instructions: 'probe', context: { campaignId: 'c', nodeId: 'n' } }),
    (error) => error.retryable === false
      && error.receipt?.usageComplete === false
      && error.receipt?.usage === null,
  );
  fs.symlinkSync('/tmp', path.join(paper, 'unsafe-link'));
  const isolated = createIsolatedAgentExecutor({ delegate: fallback, isolationRoot: path.join(root, 'isolated') });
  await assert.rejects(() => isolated.execute({ role: 'writer', workspacePath: paper, instructions: 'probe' }), /isolated_workspace_symlink_forbidden/);
});

test('isolated merge rejects a delegate-created symlink and preserves the source preimage', async (t) => {
  const root = temporary(t, 'hepta-isolated-merge-symlink-');
  const paper = path.join(root, 'paper');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(paper);
  fs.writeFileSync(path.join(paper, 'main.tex'), 'before\n');
  fs.writeFileSync(outside, 'outside\n');
  const delegate = {
    executorId: 'symlink-delegate',
    capabilities: fixtureCapabilities('symlink-delegate'),
    async execute(input) {
      fs.rmSync(path.join(input.workspacePath, 'main.tex'));
      fs.symlinkSync(outside, path.join(input.workspacePath, 'main.tex'));
      return fixtureAgentReceipt('symlink-delegate', ['main.tex']);
    },
  };
  const isolated = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false });
  await assert.rejects(
    () => isolated.execute({ role: 'writer', workspacePath: paper, instructions: 'edit' }),
    (error) => error.retryable === false && error.message.startsWith('isolated_workspace_unsafe_change:main.tex:'),
  );
  assert.equal(fs.readFileSync(path.join(paper, 'main.tex'), 'utf8'), 'before\n');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
});

test('isolated merge rejects a symlinked destination parent even when source links are skipped', async (t) => {
  const root = temporary(t, 'hepta-isolated-destination-parent-symlink-');
  const paper = path.join(root, 'paper');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(paper);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(paper, 'linked'));
  const delegate = {
    executorId: 'parent-link-delegate',
    capabilities: fixtureCapabilities('parent-link-delegate'),
    async execute(input) {
      fs.mkdirSync(path.join(input.workspacePath, 'linked'));
      fs.writeFileSync(path.join(input.workspacePath, 'linked', 'new.txt'), 'agent\n');
      return fixtureAgentReceipt('parent-link-delegate', ['linked/new.txt']);
    },
  };
  const isolated = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated'), keepFailedWorkspaces: false });
  await assert.rejects(
    () => isolated.execute({ role: 'writer', workspacePath: paper, instructions: 'edit', isolationPolicy: { skipSourceSymlinks: true } }),
    (error) => error.retryable === false && error.message.includes('isolated_workspace_unsafe_change:linked/new.txt:'),
  );
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
});

test('isolated merge conflicts retain delegate usage receipts for hard budgets', async (t) => {
  const root = temporary(t, 'hepta-isolated-conflict-');
  const paper = path.join(root, 'paper');
  fs.mkdirSync(paper);
  fs.writeFileSync(path.join(paper, 'main.tex'), 'before\n');
  const delegate = { executorId: 'conflicting-delegate', capabilities: fixtureCapabilities('conflicting-delegate'), async execute(input) {
    fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'agent\n');
    fs.writeFileSync(path.join(input.context.sourceWorkspace, 'main.tex'), 'concurrent\n');
    return fixtureAgentReceipt('conflicting-delegate', ['main.tex'], { usage: { total: 7 } });
  } };
  const isolated = createIsolatedAgentExecutor({ delegate, isolationRoot: path.join(root, 'isolated') });
  await assert.rejects(
    isolated.execute({ role: 'writer', workspacePath: paper, instructions: 'edit', context: { campaignId: 'c', nodeId: 'n' } }),
    (error) => error.message === 'isolated_workspace_merge_conflict:main.tex' && error.receipt?.usage?.total === 7,
  );
});

test('global resource governor never exceeds hard slots', async () => {
  const governor = createResourceGovernor({ agent: 1, cpu: 1, gpu: 1, memoryMiB: 1024 });
  const releaseFirst = await governor.acquire({ agent: 1, memoryMiB: 512 });
  let secondEntered = false;
  const second = governor.acquire({ agent: 1, memoryMiB: 512 }).then((release) => { secondEntered = true; release(); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondEntered, false);
  assert.equal(governor.snapshot().peak.agent, 1);
  releaseFirst();
  await second;
  assert.equal(secondEntered, true);
});

test('campaign operations persist pause resume retry cancel and usage', (t) => {
  const root = temporary(t, 'hepta-campaign-operations-');
  let milliseconds = Date.parse('2026-07-11T00:00:00Z');
  const clock = { now: () => new Date(milliseconds), nowIso: () => new Date(milliseconds += 1).toISOString() };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  const campaigns = createSqliteCampaignStore({ store, clock });
  const plan = buildPaperCampaignPlan({ paperId: 'paper', sourceWorkspace: root, campaignId: 'campaign', maxRounds: 1 });
  campaigns.createCampaign(plan);
  assert.equal(store.query('SELECT slug FROM papers WHERE slug=?', ['paper']).rows[0].slug, 'paper');
  assert.equal(createTheoremQualityRevisionSink({ store, clock }).record({
    paperId: 'paper',
    sourceWorkspace: root,
    report: {
      passed: false,
      blockers: ['theorem_proof_status_missing'],
      theoremManuscriptReadinessPolicyHash: hashRecord('FixturePolicy', {}),
    },
  }).status, 'theorem_quality_revision_requests_materialized');
  const [prePauseLease] = campaigns.claimReady({ campaignId: 'campaign', workerId: 'pre-pause-worker' });
  assert.equal(campaigns.pauseCampaign('campaign').status, 'paused');
  assert.equal(campaigns.listNodes('campaign').find((node) => node.nodeId === prePauseLease.nodeId).status, 'queued');
  assert.equal(campaigns.resumeCampaign('campaign').status, 'running');
  assert.equal(campaigns.recordUsage('campaign', { agentCalls: 2, cpuJobs: 1, tokens: 42 }).agentCallCount, 2);
  const [leased] = campaigns.claimReady({ campaignId: 'campaign', workerId: 'worker' });
  campaigns.startNode({ nodeId: leased.nodeId, workerId: 'worker', attemptId: leased.attemptId, leaseGeneration: leased.leaseGeneration });
  assert.equal(campaigns.getCampaign('campaign').currentPhase, leased.kind);
  campaigns.failNode({ nodeId: leased.nodeId, workerId: 'worker', attemptId: leased.attemptId, leaseGeneration: leased.leaseGeneration, retryable: false });
  assert.equal(campaigns.retryNode(leased.nodeId).status, 'queued');
  assert.equal(campaigns.getCampaign('campaign').currentPhase, leased.kind);
  assert.equal(campaigns.cancelCampaign('campaign').status, 'cancelled');
});

test('budget-stopped campaigns require an explicit increase and reopen only budget-skipped nodes', (t) => {
  const root = temporary(t, 'hepta-campaign-budget-resume-');
  let milliseconds = Date.parse('2026-07-11T00:00:00Z');
  const clock = { now: () => new Date(milliseconds), nowIso: () => new Date(milliseconds += 1).toISOString() };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  const campaigns = createSqliteCampaignStore({ store, clock });
  const plan = buildPaperCampaignPlan({
    paperId: 'paper',
    sourceWorkspace: root,
    campaignId: 'budget-resume-campaign',
    maxRounds: 1,
    budgets: { maxCpuJobs: 0 },
  });
  campaigns.createCampaign(plan);
  campaigns.stopCampaign(plan.campaignId, 'campaign_cpu_job_budget_exhausted');
  assert.throws(
    () => campaigns.resumeCampaign(plan.campaignId),
    /campaign_budget_extension_required:maxCpuJobs/,
  );
  assert.throws(
    () => campaigns.resumeCampaign(plan.campaignId, { budgetOverrides: { maxCpuJobs: 0 } }),
    /campaign_budget_extension_required:maxCpuJobs/,
  );
  const resumed = campaigns.resumeCampaign(plan.campaignId, { budgetOverrides: { maxCpuJobs: 2, maxTokenCount: 750000 } });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.spec.budgets.maxCpuJobs, 2);
  assert.equal(resumed.spec.budgets.maxTokenCount, 750000);
  assert.notEqual(resumed.spec.campaignPlanHash, plan.campaignPlanHash);
  assert.ok(campaigns.listNodes(plan.campaignId).every((node) => node.status === 'queued'));
  assert.ok(campaigns.listNodes(plan.campaignId).every((node) => node.failureClass === null));
  assert.equal(campaigns.listEvents(plan.campaignId).at(-1).event.kind, 'campaign_resumed');
});

test('non-budget stopped campaigns cannot be resumed', (t) => {
  const root = temporary(t, 'hepta-campaign-terminal-stop-');
  let milliseconds = Date.parse('2026-07-11T00:00:00Z');
  const clock = { now: () => new Date(milliseconds), nowIso: () => new Date(milliseconds += 1).toISOString() };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  const campaigns = createSqliteCampaignStore({ store, clock });
  const plan = buildPaperCampaignPlan({ paperId: 'paper', sourceWorkspace: root, campaignId: 'terminal-stop-campaign', maxRounds: 1 });
  campaigns.createCampaign(plan);
  campaigns.stopCampaign(plan.campaignId, 'referee_convergence_not_reached_within_budget');
  assert.throws(() => campaigns.resumeCampaign(plan.campaignId), /campaign_not_resumable/);
});

test('nonconverged campaigns append a review round without replaying completed work', (t) => {
  const root = temporary(t, 'hepta-campaign-round-extension-');
  let milliseconds = Date.parse('2026-07-11T00:00:00Z');
  const clock = { now: () => new Date(milliseconds), nowIso: () => new Date(milliseconds += 1).toISOString() };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  const campaigns = createSqliteCampaignStore({ store, clock });
  const first = buildPaperCampaignPlan({ paperId: 'paper', sourceWorkspace: root, campaignId: 'extended-campaign', maxRounds: 1 });
  campaigns.createCampaign(first);
  campaigns.stopCampaign(first.campaignId, 'referee_convergence_not_reached_within_budget');
  const second = buildPaperCampaignPlan({
    paperId: 'paper',
    sourceWorkspace: root,
    campaignId: first.campaignId,
    maxRounds: 2,
    budgets: { ...first.budgets, maxAgentCalls: first.budgets.maxAgentCalls + 4 },
  });
  const extended = campaigns.extendCampaign(second);
  assert.equal(extended.status, 'running');
  assert.equal(extended.maxRounds, 2);
  assert.equal(extended.spec.campaignPlanHash, second.campaignPlanHash);
  const nodes = campaigns.listNodes(first.campaignId);
  assert.equal(nodes.find((node) => node.kind === 'package' && node.roundIndex === 2).failureClass, 'campaign_round_extension_superseded');
  assert.equal(nodes.find((node) => node.kind === 'referee-1' && node.roundIndex === 2).status, 'queued');
  assert.equal(nodes.find((node) => node.kind === 'package' && node.roundIndex === 3).status, 'queued');
  assert.equal(campaigns.listEvents(first.campaignId).at(-1).event.kind, 'campaign_extended');
});

test('manuscript citation and artifact checks are deterministic and fail closed', (t) => {
  const root = temporary(t, 'hepta-quality-check-');
  fs.writeFileSync(path.join(root, 'main.tex'), '\\cite{known}\\includegraphics{figure}\\begin{table}ok\\end{table}\n% HEPTA_RESULT results.json#metric=1\n');
  fs.writeFileSync(path.join(root, 'references.bib'), '@article{known,title={Known}}\n');
  fs.writeFileSync(path.join(root, 'figure.png'), 'fixture');
  fs.writeFileSync(path.join(root, 'results.json'), '{"metric":1}\n');
  assert.equal(runManuscriptQualityChecks({ workspacePath: root }).passed, true);
  fs.writeFileSync(path.join(root, 'main.tex'), '\\cite{missing} TODO \\includegraphics{absent}\n');
  const failed = runManuscriptQualityChecks({ workspacePath: root });
  assert.equal(failed.passed, false);
  assert.ok(failed.blockers.includes('missing_bibliography_entries'));
  assert.ok(failed.blockers.includes('missing_figure_artifacts'));
  fs.writeFileSync(path.join(root, 'main.tex'), '% HEPTA_RESULT results.json#metric=2\n');
  assert.ok(runManuscriptQualityChecks({ workspacePath: root }).blockers.includes('claim_result_provenance_mismatch'));
  fs.writeFileSync(path.join(root, 'results.json'), '{"metric":1,"interval":[1,1]}\n');
  fs.writeFileSync(path.join(root, 'main.tex'), '\\cite{inline}\\begin{thebibliography}{1}\\bibitem{inline} Inline.\\end{thebibliography}\n% HEPTA_RESULT results.json#interval=[1.0,1.0]\n');
  assert.equal(runManuscriptQualityChecks({ workspacePath: root }).passed, true);
  fs.writeFileSync(path.join(root, 'main.tex'), '\\begin{table}observed metric: 1\\end{table}\n');
  assert.ok(runManuscriptQualityChecks({ workspacePath: root }).blockers.includes('empirical_claim_provenance_missing'));
  fs.rmSync(path.join(root, 'results.json'));
  fs.writeFileSync(path.join(root, 'main.tex'), '\\begin{table}theorem cases\\end{table}\n');
  assert.equal(runManuscriptQualityChecks({ workspacePath: root }).passed, true);
  assert.ok(runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true }).blockers.includes('table_or_figure_without_empirical_artifact'));
});

test('self-created result JSON cannot authorize manuscript numbers without accepted original and replay ledger evidence', (t) => {
  const root = temporary(t, 'hepta-untrusted-result-authority-');
  fs.mkdirSync(path.join(root, 'automation-results'));
  fs.writeFileSync(path.join(root, 'automation-results', 'results.json'), '{"score":0.99}\n');
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '% HEPTA_RESULT automation-results/results.json#score=0.99',
    'The empirical result score was 0.99.',
  ].join('\n'));
  const receipt = runManuscriptQualityChecks({
    workspacePath: root,
    requiresEmpiricalArtifacts: true,
    requiresTrustedEmpiricalAuthority: true,
    experimentRegistry: null,
    expectedPaperId: 'paper',
    expectedCampaignId: 'campaign',
  });
  assert.equal(receipt.passed, false);
  assert.ok(receipt.blockers.includes('empirical_result_registry_authority_invalid'));
  assert.ok(receipt.blockers.includes('empirical_result_artifact_authority_missing'));
  assert.ok(receipt.blockers.includes('claim_result_provenance_mismatch'));
});

test('typed autonomous manuscript revalidation fails closed without its bound authority', (t) => {
  const root = temporary(t, 'hepta-typed-manuscript-authority-');
  fs.writeFileSync(path.join(root, 'main.tex'), 'A typed empirical manuscript.\n');
  const receipt = runManuscriptQualityChecks({
    workspacePath: root,
    requiresEmpiricalArtifacts: true,
    expectedPaperId: 'paper',
    expectedCampaignId: 'campaign',
    trustedAutonomousManuscriptRenderReceipt: {},
    trustedAutonomousManuscriptCampaignNodes: [],
  });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.details.trustedAutonomousManuscriptAuthorityRequired, true);
  assert.ok(receipt.blockers.includes('trusted_autonomous_manuscript_revalidation_invalid'));
  assert.ok(receipt.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_materialized_authority_mismatch',
  ));
  assert.equal(receipt.blockers.includes('empirical_claim_provenance_missing'), false);
  assert.equal(receipt.blockers.includes('empirical_numeric_claim_provenance_missing'), false);
  assert.equal(receipt.blockers.includes('empirical_assertion_provenance_missing'), false);
});

test('typed autonomous manuscript revalidation returns a hash-bound failure for malformed arrays', (t) => {
  const root = temporary(t, 'hepta-typed-manuscript-malformed-arrays-');
  fs.writeFileSync(path.join(root, 'main.tex'), 'A typed empirical manuscript.\n');
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR.json'), JSON.stringify({
    authorityBindings: { forged: true },
  }));
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json'), JSON.stringify({
    sourceEvidenceDocuments: { forged: true },
  }));
  const receipt = runManuscriptQualityChecks({
    workspacePath: root,
    mode: 'artifacts',
    requiresEmpiricalArtifacts: true,
    expectedPaperId: 'paper',
    expectedCampaignId: 'campaign',
    trustedAutonomousManuscriptRenderReceipt: {
      manuscriptIrPath: 'AUTONOMOUS_MANUSCRIPT_IR.json',
      evidenceEntailmentContractPath: 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json',
      presentationArtifacts: { path: 'figures/forged.pdf' },
    },
    trustedAutonomousManuscriptCampaignNodes: { forged: true },
  });
  const revalidation = receipt.details.trustedAutonomousManuscriptRevalidation;
  assert.equal(receipt.passed, false);
  assert.equal(revalidation.passed, false);
  assert.ok(revalidation.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_presentation_artifact_invalid',
  ));
  assert.ok(revalidation.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_source_evidence_document_invalid',
  ));
  assert.ok(revalidation.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_ir_authority_binding_invalid',
  ));
  assert.ok(revalidation.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_campaign_node_invalid',
  ));
  assert.match(
    revalidation.trustedAutonomousManuscriptWorkspaceRevalidationReceiptHash,
    /^sha256:[0-9a-f]{64}$/,
  );

  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json'), JSON.stringify({
    sourceEvidenceDocuments: [null],
  }));
  const nullDocumentReceipt = runManuscriptQualityChecks({
    workspacePath: root,
    mode: 'artifacts',
    requiresEmpiricalArtifacts: true,
    expectedPaperId: 'paper',
    expectedCampaignId: 'campaign',
    trustedAutonomousManuscriptRenderReceipt: {
      manuscriptIrPath: 'AUTONOMOUS_MANUSCRIPT_IR.json',
      evidenceEntailmentContractPath: 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json',
      presentationArtifacts: [],
    },
    trustedAutonomousManuscriptCampaignNodes: [],
  });
  const nullDocumentRevalidation =
    nullDocumentReceipt.details.trustedAutonomousManuscriptRevalidation;
  assert.equal(nullDocumentRevalidation.passed, false);
  assert.ok(nullDocumentRevalidation.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_source_evidence_document_invalid',
  ));
  assert.match(
    nullDocumentRevalidation.trustedAutonomousManuscriptWorkspaceRevalidationReceiptHash,
    /^sha256:[0-9a-f]{64}$/,
  );
});

test('production artifact revalidation selects only a hash-valid manuscript result', () => {
  const paperId = 'paper-quality-revalidation';
  const campaignId = 'campaign-quality-revalidation';
  const release = genericManuscriptReleaseFixture({
    paperId,
    campaignId,
    campaignPlanHash: hashRecord('FixtureCampaignPlan', { campaignId }),
    launchMode: 'production-run',
    externalSubmission: true,
    includeProof: true,
  });
  const proof = release.trustedAutonomousManuscriptResult;
  const integratedResult = Object.freeze({
    ...proof.result,
    workspaceAttemptIntegration: Object.freeze({
      workspaceAttemptIntegrationDescriptorHash:
        hashRecord('FixtureWorkspaceAttemptIntegrationDescriptor', { campaignId }),
    }),
  });
  const candidate = Object.freeze({
    ...proof,
    campaignId,
    paperId,
    nodeId: '1:revise',
    kind: 'revise',
    role: 'writer',
    roundIndex: 1,
    status: 'completed',
    result: integratedResult,
    resultSha256: hashRecord('PaperCampaignNodeResult', integratedResult),
  });
  const qualityCalls = [];
  const primitives = {
    workspace: {
      hashFile() { return release.releaseBinding.renderedManuscriptHash; },
    },
    quality: {
      manuscriptQuality(input) {
        qualityCalls.push(input);
        return Object.freeze({ passed: true, blockers: Object.freeze([]) });
      },
    },
  };
  const campaign = {
    paperId,
    campaignId,
    spec: {
      paperQualityProfiles: ['empirical_or_experiment'],
      languages: ['latex'],
      autonomousResearchPreparation: release.preparation,
      scientificClaimAuthority: { claimAuthorityType: 'machine-policy-authorized' },
    },
  };
  const node = { kind: 'revalidate-artifacts' };
  const context = {
    revisionNode: { result: { changedPaths: ['figures/result.pdf'] } },
    campaignNodes: [candidate],
  };
  const input = { primitives, campaign, node, context, workspace: '/fixture', manuscript: 'main.tex' };
  assert.equal(executeCampaignQualityRevalidationNode(input).passed, true);
  assert.equal(qualityCalls.length, 1);
  assert.equal(
    qualityCalls[0].trustedAutonomousManuscriptRenderReceiptHash,
    undefined,
  );
  assert.equal(
    qualityCalls[0].trustedAutonomousManuscriptRenderReceipt
      .trustedAutonomousManuscriptRenderReceiptHash,
    candidate.result.trustedAutonomousManuscriptRenderReceiptHash,
  );
  assert.deepEqual(qualityCalls[0].trustedAutonomousManuscriptCampaignNodes, [candidate]);
  assert.equal(
    Object.hasOwn(qualityCalls[0], 'trustedAutonomousManuscriptFormalVerificationReceipt'),
    false,
  );

  const legacyCampaign = {
    ...campaign,
    spec: {
      paperQualityProfiles: ['empirical_or_experiment'],
      languages: ['latex'],
    },
  };
  const legacy = {
    ...input,
    campaign: legacyCampaign,
    context: { ...context, campaignNodes: [] },
  };
  assert.equal(executeCampaignQualityRevalidationNode(legacy).passed, true);
  assert.equal(qualityCalls.length, 2);
  assert.equal(qualityCalls[1].trustedAutonomousManuscriptRenderReceipt, null);
  assert.equal(qualityCalls[1].trustedAutonomousManuscriptAgentExecutionReceipt, null);

  const blockedReceipt = Object.freeze({
    passed: false,
    blockers: Object.freeze([
      'trusted_autonomous_manuscript_revalidation_presentation_artifact_invalid',
    ]),
  });
  assert.throws(
    () => executeCampaignQualityRevalidationNode({
      ...input,
      primitives: {
        ...primitives,
        quality: { manuscriptQuality() { return blockedReceipt; } },
      },
    }),
    (error) => error.retryable === false && error.receipt === blockedReceipt,
  );

  const missing = { ...input, context: { ...context, campaignNodes: [] } };
  assert.throws(
    () => executeCampaignQualityRevalidationNode(missing),
    (error) => error.message
        === 'campaign_revalidation_trusted_autonomous_manuscript_authority_required'
      && error.retryable === false,
  );

  const validResult = candidate.result;
  const {
    campaignTrustedAutonomousManuscriptResultHash: _resultHash,
    workspaceAttemptIntegration,
    ...validResultPayload
  } = validResult;
  const tamperedReceipt = {
    ...validResult.trustedAutonomousManuscriptRenderReceipt,
    manuscriptHash: hashRecord('FixtureTamperedManuscript', { campaignId }),
  };
  const tamperedResultPayload = {
    ...validResultPayload,
    trustedAutonomousManuscriptRenderReceipt: tamperedReceipt,
  };
  const tamperedResult = {
    ...tamperedResultPayload,
    campaignTrustedAutonomousManuscriptResultHash: hashRecord(
      'CampaignTrustedAutonomousManuscriptResult',
      tamperedResultPayload,
    ),
    workspaceAttemptIntegration,
  };
  const tamperedCandidate = {
    ...candidate,
    result: tamperedResult,
    resultSha256: hashRecord('PaperCampaignNodeResult', tamperedResult),
  };
  const tampered = {
    ...input,
    context: { ...context, campaignNodes: [tamperedCandidate] },
  };
  assert.throws(
    () => executeCampaignQualityRevalidationNode(tampered),
    (error) => error.message
        === 'campaign_revalidation_trusted_autonomous_manuscript_authority_required'
      && error.retryable === false,
  );
});

test('manuscript empirical provenance covers the recursive TeX corpus and every numeric result claim', (t) => {
  const root = temporary(t, 'hepta-quality-provenance-corpus-');
  fs.mkdirSync(path.join(root, 'sections'), { recursive: true });
  fs.writeFileSync(path.join(root, 'results.json'), '{"accuracy":0.91,"latency":12}\n');
  fs.writeFileSync(path.join(root, 'main.tex'), '\\input{sections/results}\n');
  fs.writeFileSync(path.join(root, 'sections', 'results.tex'), [
    '% HEPTA_RESULT results.json#accuracy=0.91',
    'The observed accuracy was 91\\%.',
    'The observed latency was 12 ms.',
  ].join('\n'));
  const unbound = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.ok(unbound.blockers.includes('empirical_numeric_claim_provenance_missing'));
  assert.deepEqual(unbound.details.manuscriptCorpusFiles, ['main.tex', 'sections/results.tex']);
  assert.equal(unbound.details.unboundEmpiricalNumericClaims.length, 1);
  assert.equal(unbound.details.unboundEmpiricalNumericClaims[0].sourcePath, 'sections/results.tex');

  fs.writeFileSync(path.join(root, 'sections', 'results.tex'), [
    '% HEPTA_RESULT results.json#accuracy=0.91',
    'The observed accuracy was 91\\%.',
    '% HEPTA_RESULT results.json#latency=12',
    'The observed latency was 12 ms.',
  ].join('\n'));
  const bound = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.equal(bound.passed, true, JSON.stringify(bound.blockers));
  assert.equal(bound.details.resultProvenanceMarkerCount, 2);
  assert.deepEqual(bound.details.unboundEmpiricalNumericClaims, []);
});

test('empirical manuscript checks reject keyword-free numbers and fake figure bytes', (t) => {
  const root = temporary(t, 'hepta-quality-adversarial-provenance-');
  fs.mkdirSync(path.join(root, 'automation-results'));
  fs.writeFileSync(path.join(root, 'automation-results', 'results.json'), '{"score":0.734}\n');
  fs.writeFileSync(path.join(root, 'fake.png'), 'not-a-real-figure');
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '% HEPTA_RESULT automation-results/results.json#score=0.734',
    'Filler prose.',
    'Filler prose.',
    'Filler prose.',
    'Our method reached 73.4 percent.',
    'The ablation dominates every alternative in practice.',
    '\\includegraphics{fake.png}',
  ].join('\n'));
  const receipt = runManuscriptQualityChecks({
    workspacePath: root,
    requiresEmpiricalArtifacts: true,
  });
  assert.equal(receipt.passed, false);
  assert.ok(receipt.blockers.includes('empirical_numeric_claim_provenance_missing'));
  assert.ok(receipt.blockers.includes('empirical_assertion_provenance_missing'));
  assert.ok(receipt.blockers.includes('invalid_figure_artifacts'));
  assert.ok(receipt.blockers.includes('empirical_figure_artifacts_unsupported'));
});

test('manuscript quality checks bind canonical CSV metrics by name and reject partial numeric coverage', (t) => {
  const root = temporary(t, 'hepta-manuscript-csv-provenance-');
  fs.writeFileSync(path.join(root, 'results.csv'), 'metric,value\naccuracy,0.91\nlatency_ms,27\n');
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '% HEPTA_RESULT results.csv#accuracy=0.91',
    '% HEPTA_RESULT results.csv#latency_ms=27',
    'The empirical result has accuracy 0.91 and latency 27 ms.',
  ].join('\n'));

  const complete = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.equal(complete.passed, true, JSON.stringify(complete.blockers));

  fs.writeFileSync(path.join(root, 'main.tex'), [
    '% HEPTA_RESULT results.csv#accuracy=0.91',
    'The empirical result has accuracy 0.91 and latency 27 ms.',
  ].join('\n'));
  const partial = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.equal(partial.passed, false);
  assert.ok(partial.blockers.includes('empirical_numeric_claim_provenance_missing'));
});

test('manuscript quality checks reject result and TeX-input symlinks that escape the workspace', (t) => {
  const root = temporary(t, 'hepta-manuscript-symlink-provenance-');
  const outside = temporary(t, 'hepta-manuscript-symlink-outside-');
  fs.writeFileSync(path.join(outside, 'results.json'), '{"score":0.95}\n');
  fs.writeFileSync(path.join(outside, 'claims.tex'), 'The empirical result is 0.95.\n');
  fs.symlinkSync(path.join(outside, 'results.json'), path.join(root, 'results.json'));
  fs.symlinkSync(path.join(outside, 'claims.tex'), path.join(root, 'claims.tex'));
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '% HEPTA_RESULT results.json#score=0.95',
    '\\input{claims}',
  ].join('\n'));

  const receipt = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.equal(receipt.passed, false);
  assert.ok(receipt.blockers.includes('claim_result_provenance_mismatch'));
  assert.ok(receipt.blockers.includes('missing_table_or_input_artifacts'));
});
