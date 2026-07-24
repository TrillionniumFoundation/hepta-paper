import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOpenClawAgentExecutor, openClawAgentCapabilityProfileHash } from '../../paper-adapters/automation/openclaw-agent-executor.mjs';
import { openClawAgentConfigurationHash, openClawGatewayConfigurationHash } from '../../paper-adapters/automation/openclaw-agent-configuration.mjs';
import { createAgentBackendRouter } from '../../paper-adapters/automation/agent-backend-router.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import { runManuscriptQualityChecks } from '../../paper-adapters/automation/manuscript-quality-checks.mjs';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

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
  const router = createAgentBackendRouter({ primary: { executorId: 'primary', capabilities: fixtureCapabilities('primary'), async execute() { const error = new Error('offline'); error.retryable = true; throw error; } }, fallbacks: [fallback] });
  const executor = createIsolatedAgentExecutor({ delegate: router, isolationRoot: isolation, keepWorkspaces: false });
  const receipt = await executor.execute({ role: 'writer', workspacePath: paper, instructions: 'edit', context: { campaignId: 'c', nodeId: 'n' } });
  assert.equal(receipt.selectedExecutorId, 'fallback');
  assert.equal(receipt.fallbackCount, 1);
  assert.equal(fs.readFileSync(path.join(paper, 'main.tex'), 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(path.join(paper, 'NEW.md'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(path.join(paper, '__pycache__')), false);
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

test('OpenClaw timeout is eligible for fallback while isolated workspaces reject symlinks', async (t) => {
  const root = temporary(t, 'hepta-openclaw-timeout-');
  const paper = path.join(root, 'paper');
  fs.mkdirSync(paper);
  fs.writeFileSync(path.join(paper, 'main.tex'), 'before\n');
  const slow = path.join(root, 'slow.sh');
  fs.writeFileSync(slow, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(slow, 0o755);
  const primary = createOpenClawAgentExecutor({ openclawBinary: slow, agentId: 'fixture', timeoutMs: 25, ...openClawPolicy('fixture', paper) });
  const fallback = { executorId: 'fallback-after-timeout', capabilities: fixtureCapabilities('fallback-after-timeout'), async execute() { return { status: 'agent_execution_completed', changedPaths: [], agentExecutionReceiptHash: 'sha256:fallback-timeout' }; } };
  const receipt = await createAgentBackendRouter({ primary, fallbacks: [fallback] }).execute({ role: 'writer', workspacePath: paper, instructions: 'probe', context: { campaignId: 'c', nodeId: 'n' } });
  assert.equal(receipt.selectedExecutorId, 'fallback-after-timeout');
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
