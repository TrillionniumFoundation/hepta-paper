import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { buildExecutorCapabilities, capabilityRequestFromExecution, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function manifest(root) {
  const rows = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', 'node_modules', 'runtime', '.artifact-cas'].includes(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) rows.push([relative, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
    }
  };
  walk(root);
  return rows;
}

function changes(before, after) {
  const left = new Map(before);
  const right = new Map(after);
  return [...new Set([...left.keys(), ...right.keys()])].filter((key) => left.get(key) !== right.get(key)).sort();
}

function run(spawnImpl, executable, args, { cwd, timeoutMs, signal = null }) {
  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawnImpl(executable, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: useProcessGroup });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let hardKill = null;
    const kill = (signalName) => {
      if (useProcessGroup && child.pid) {
        try { process.kill(-child.pid, signalName); return; } catch { /* process may already have exited */ }
      }
      child.kill(signalName);
    };
    const terminate = () => {
      kill('SIGTERM');
      hardKill = setTimeout(() => kill('SIGKILL'), 5000);
      hardKill.unref?.();
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const abort = () => terminate();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); if (hardKill) clearTimeout(hardKill); signal?.removeEventListener('abort', abort); resolve({ exitCode: null, signal: null, stdout, stderr, error, timedOut }); });
    child.on('close', (exitCode, childSignal) => { clearTimeout(timer); if (hardKill) clearTimeout(hardKill); signal?.removeEventListener('abort', abort); resolve({ exitCode, signal: childSignal, stdout, stderr, error: null, timedOut }); });
  });
}

function parseResult(stdout) {
  const source = String(stdout || '').trim();
  if (!source) return null;
  try { return JSON.parse(source); } catch { /* CLI diagnostics may precede JSON */ }
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join('\n');
    try { return JSON.parse(candidate); } catch { /* continue */ }
  }
  return null;
}

function responseText(parsed, stdout) {
  const candidates = [
    parsed?.result?.payloads?.[0]?.text,
    parsed?.result?.meta?.finalAssistantVisibleText,
    parsed?.result?.meta?.finalAssistantRawText,
    parsed?.response,
    parsed?.reply,
    parsed?.message,
    parsed?.result?.response,
    parsed?.result?.reply,
    parsed?.result?.message,
    parsed?.payload?.text,
  ];
  const value = candidates.find((item) => typeof item === 'string');
  return value || String(stdout || '').slice(-16000);
}

function parseAgentOutput(text) {
  const source = String(text || '').trim();
  try { return JSON.parse(source); } catch { /* bounded agent output can contain prose */ }
  const match = source.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export function createOpenClawAgentExecutor({
  openclawBinary = 'openclaw',
  agentId = process.env.HEPTA_OPENCLAW_AGENT || 'hepta-paper-worker',
  model = process.env.HEPTA_OPENCLAW_MODEL || null,
  thinking = process.env.HEPTA_OPENCLAW_THINKING || 'high',
  spawnImpl = spawn,
  timeoutMs = 45 * 60 * 1000,
} = {}) {
  const executorId = 'openclaw-agent-executor-v1';
  const capabilities = buildExecutorCapabilities({
    executorId,
    sandboxModes: ['read-only', 'workspace-write'],
    networkPolicy: 'provider-controlled',
    workspaceIsolation: false,
    maximumTimeoutMs: timeoutMs,
    maximumOutputTokens: null,
    receiptKinds: ['AgentExecutionReceipt'],
    provider: 'openclaw',
  });
  return assertAgentExecutorPort({
    version: 1,
    kind: 'OpenClawAgentExecutor',
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
      if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('agent sandbox must be read-only or workspace-write');
      const before = manifest(workspace);
      const sessionNonce = crypto.randomUUID();
      const sessionKey = `agent:${agentId}:hepta-paper-${String(context.campaignId || 'campaign').replace(/[^A-Za-z0-9_.-]/g, '_')}-${String(context.nodeId || role).replace(/[^A-Za-z0-9_.-]/g, '_')}-${sessionNonce}`;
      const prompt = [
        `You are the independent ${role} node in a hepta-paper automation campaign.`,
        `The paper workspace is ${workspace}.`,
        sandbox === 'read-only' ? 'Read and review only. Do not modify any file.' : 'Make only the requested changes inside that workspace.',
        'Do not submit papers, send messages, use credentials, or perform external mutations.',
        String(instructions),
        `Structured context: ${JSON.stringify({ ...context, workspacePath: workspace })}`,
        requiredChecks.length ? `Run applicable checks before finishing: ${requiredChecks.join(' ; ')}` : '',
        outputTokenBudget ? `Keep the final response within ${Math.max(128, Number(outputTokenBudget))} output tokens. Prefer editing files with tools over returning file bodies.` : '',
        'Finish with one compact JSON object containing status, summary, checksRun, and blockers. If the task instructions request role-specific JSON fields (for example verdict, score, criticalFindingCount, and findings), include those fields in the same final object.',
      ].filter(Boolean).join('\n\n');
      const promptHash = `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`;
      const args = ['agent', '--agent', agentId, '--session-key', sessionKey, '--message', prompt, '--json', '--thinking', thinking, '--timeout', String(Math.max(1, Math.ceil(Math.min(Number(requestedTimeout || timeoutMs), timeoutMs) / 1000)))];
      if (model) args.push('--model', model);
      const startedAt = new Date().toISOString();
      const processResult = await run(spawnImpl, openclawBinary, args, { cwd: workspace, timeoutMs: Math.min(Number(requestedTimeout || timeoutMs), timeoutMs) + 5000, signal });
      const completedAt = new Date().toISOString();
      const parsed = parseResult(processResult.stdout);
      const finalOutput = responseText(parsed, processResult.stdout);
      const structuredOutput = parseAgentOutput(finalOutput);
      const childSessionId = parsed?.sessionId || parsed?.session_id || parsed?.result?.sessionId || parsed?.result?.meta?.agentMeta?.sessionId || null;
      const resolvedModel = parsed?.result?.meta?.agentMeta?.model
        || parsed?.result?.meta?.agentMeta?.modelId
        || parsed?.model
        || model
        || null;
      const changedPaths = changes(before, manifest(workspace));
      const blockers = [];
      if (processResult.timedOut) blockers.push('openclaw_agent_timeout');
      if (signal?.aborted) blockers.push('openclaw_agent_cancelled');
      if (processResult.exitCode !== 0 || processResult.error) blockers.push('openclaw_agent_process_failed');
      if (sandbox === 'read-only' && changedPaths.length) blockers.push('read_only_agent_modified_workspace');
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        executorId,
        providerMode: 'openclaw:detached-child-session',
        agentId,
        model,
        resolvedModel,
        promptHash,
        maximumOutputTokens: outputTokenBudget ? Math.max(128, Number(outputTokenBudget)) : null,
        role,
        sessionKey,
        sessionId: childSessionId,
        childSessionId,
        status: blockers.length ? 'agent_execution_failed' : 'agent_execution_completed',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        changedPaths,
        finalOutput: finalOutput.slice(-16000),
        structuredOutput,
        openClawRunId: parsed?.runId || null,
        usage: parsed?.result?.meta?.agentMeta?.usage || null,
        blockers,
        stdoutHash: `sha256:${crypto.createHash('sha256').update(processResult.stdout).digest('hex')}`,
        stderrHash: `sha256:${crypto.createHash('sha256').update(processResult.stderr).digest('hex')}`,
        stderrTail: processResult.stderr.slice(-8000),
        startedAt,
        completedAt,
        externalActionPerformed: false,
      };
      const receipt = Object.freeze({ ...payload, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload) });
      if (payload.status !== 'agent_execution_completed') {
        const error = new Error(blockers.join(',') || processResult.error?.message || `openclaw agent exited ${processResult.exitCode}`);
        error.retryable = !signal?.aborted && !blockers.includes('read_only_agent_modified_workspace');
        error.receipt = receipt;
        throw error;
      }
      return receipt;
    },
  });
}
