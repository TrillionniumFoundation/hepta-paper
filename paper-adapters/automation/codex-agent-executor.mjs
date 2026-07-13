import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { buildExecutorCapabilities, capabilityRequestFromExecution, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { runBoundedChildProcess } from './bounded-child-process.mjs';
import { changedWorkspacePaths, createWorkspaceManifest, readOnlyMutationBlockers } from './workspace-change-tracker.mjs';

export function createCodexAgentExecutor({
  codexBinary = 'codex',
  model = null,
  oss = false,
  localProvider = 'ollama',
  spawnImpl = spawn,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  const executorId = 'codex-agent-executor-v1';
  const capabilities = buildExecutorCapabilities({
    executorId,
    sandboxModes: ['read-only', 'workspace-write'],
    networkPolicy: oss ? 'local-provider-only' : 'sandbox-restricted',
    workspaceIsolation: false,
    maximumTimeoutMs: timeoutMs,
    maximumOutputTokens: null,
    receiptKinds: ['AgentExecutionReceipt'],
    provider: oss ? `local:${localProvider}` : 'openai',
  });
  return assertAgentExecutorPort({
    version: 1,
    kind: 'CodexAgentExecutor',
    executorId,
    capabilities: () => capabilities,
    async execute(input = {}) {
      const { role, workspacePath, instructions, context = {}, requiredChecks = [], sandbox = 'workspace-write', outputTokenBudget = null, timeoutMs: requestedTimeout = null, signal = null } = input;
      const preflight = evaluateExecutorCapabilityRequest({ capabilities, request: capabilityRequestFromExecution({ ...input, sandbox, outputTokenBudget, timeoutMs: requestedTimeout }) });
      if (preflight.blockers.length) throw new Error(preflight.blockers.join(','));
      const workspace = path.resolve(workspacePath || '');
      if (!role || !instructions || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
        throw new Error('agent role, existing workspacePath and instructions are required');
      }
      const before = createWorkspaceManifest(workspace);
      const prompt = [
        `You are the ${role} for an automated paper campaign.`,
        'Work only inside the provided workspace. Do not submit externally, send messages, or access credentials.',
        String(instructions),
        `Structured context: ${JSON.stringify(context)}`,
        requiredChecks.length ? `Before finishing run these checks when applicable: ${requiredChecks.join(' ; ')}` : '',
        outputTokenBudget ? `Keep the final response within ${Math.max(128, Number(outputTokenBudget))} output tokens. Prefer editing files with tools over returning file bodies.` : '',
        'Finish with one compact JSON object containing status, summary, checksRun, and blockers. Include every role-specific JSON field explicitly requested by the task in that same object.',
      ].filter(Boolean).join('\n\n');
      const promptHash = `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`;
      const sessionId = `codex-exec:${crypto.randomUUID()}`;
      if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('agent sandbox must be read-only or workspace-write');
      const args = ['exec'];
      if (oss) args.push('--oss', '--local-provider', localProvider);
      if (model) args.push('--model', model);
      args.push('--ephemeral', '--color', 'never', '--sandbox', sandbox, '--skip-git-repo-check', '--cd', workspace, '-');
      const startedAt = new Date().toISOString();
      const processResult = await runBoundedChildProcess({
        spawnImpl,
        executable: codexBinary,
        args,
        cwd: workspace,
        env: { ...process.env, HEPTA_AUTOMATION_ROLE: role },
        stdin: prompt,
        timeoutMs: Math.min(Number(requestedTimeout || timeoutMs), timeoutMs),
        signal,
      });
      const completedAt = new Date().toISOString();
      const changes = changedWorkspacePaths(before, createWorkspaceManifest(workspace));
      const blockers = [];
      if (processResult.timedOut) blockers.push('codex_agent_timeout');
      if (processResult.aborted) blockers.push('codex_agent_cancelled');
      if (processResult.exitCode !== 0 || processResult.error) blockers.push('codex_agent_process_failed');
      blockers.push(...readOnlyMutationBlockers({ sandbox, changedPaths: changes }));
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        executorId,
        providerMode: oss ? `local:${localProvider}` : 'openai',
        model,
        resolvedModel: model,
        promptHash,
        sessionId,
        childSessionId: sessionId,
        maximumOutputTokens: outputTokenBudget ? Math.max(128, Number(outputTokenBudget)) : null,
        role,
        status: blockers.length ? 'agent_execution_failed' : 'agent_execution_completed',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        changedPaths: changes,
        blockers,
        stdoutHash: processResult.stdoutHash,
        stderrHash: processResult.stderrHash,
        outputTruncated: processResult.outputTruncated,
        finalOutput: processResult.stdout.slice(-12000),
        stderrTail: processResult.stderr.slice(-12000),
        error: processResult.error?.message || null,
        startedAt,
        completedAt,
        externalActionPerformed: false,
      };
      const receipt = Object.freeze({ ...payload, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload) });
      if (payload.status !== 'agent_execution_completed') {
        const error = new Error(blockers.join(',') || payload.error || `agent exited ${payload.exitCode}`);
        error.retryable = !processResult.aborted && !blockers.includes('read_only_agent_modified_workspace');
        error.receipt = receipt;
        throw error;
      }
      return receipt;
    },
  });
}
