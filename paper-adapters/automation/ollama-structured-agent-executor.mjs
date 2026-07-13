import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { buildExecutorCapabilities, capabilityRequestFromExecution, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function within(root, candidate) { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }

function sourceFiles(root) {
  const preferred = ['main.tex', 'paper.tex', 'manuscript.tex', 'RESEARCH_PLAN.md', 'references.bib', 'run.py', 'analysis.py', 'run.mjs', 'analysis.mjs', 'run.R', 'analysis.R', 'run.jl', 'analysis.jl'];
  const selected = preferred.filter((name) => fs.existsSync(path.join(root, name)));
  const experiments = fs.existsSync(path.join(root, 'experiments'))
    ? fs.readdirSync(path.join(root, 'experiments'), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `experiments/${entry.name}`).slice(0, 12)
    : [];
  return [...new Set([...selected, ...experiments])].slice(0, 20);
}

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['status', 'summary', 'edits', 'checks', 'blockers'],
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked'] },
    summary: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        additionalProperties: false,
      },
    },
    checks: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['accept', 'revise'] },
    score: { type: 'number', minimum: 0, maximum: 1 },
    criticalFindingCount: { type: 'integer', minimum: 0 },
    findings: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
});

async function runOllama({ ollamaHost, model, prompt, timeoutMs, maximumOutputTokens, fetchImpl, signal = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(`${ollamaHost.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        format: OUTPUT_SCHEMA,
        stream: false,
        keep_alive: '10m',
        options: { temperature: 0.1, num_predict: maximumOutputTokens },
      }),
      signal: controller.signal,
    });
    const body = await response.json();
    return {
      exitCode: response.ok ? 0 : 1,
      stdout: String(body.response || ''),
      stderr: String(body.error || ''),
      error: response.ok ? null : new Error(body.error || `ollama_http_${response.status}`),
      doneReason: body.done_reason || null,
      evalCount: Number(body.eval_count || 0),
    };
  } catch (error) {
    return { exitCode: null, stdout: '', stderr: String(error?.message || error), error, doneReason: null, evalCount: 0 };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function createOllamaStructuredAgentExecutor({
  model,
  ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  fetchImpl = globalThis.fetch,
  timeoutMs = 20 * 60 * 1000,
  maximumContextBytes = 200000,
  maximumOutputTokens = 4096,
} = {}) {
  if (!model) throw new Error('Ollama model is required');
  const executorId = 'ollama-structured-agent-v1';
  const capabilities = buildExecutorCapabilities({
    executorId,
    sandboxModes: ['read-only', 'workspace-write'],
    networkPolicy: 'local-provider-only',
    workspaceIsolation: false,
    maximumTimeoutMs: timeoutMs,
    maximumOutputTokens: Math.min(8192, maximumOutputTokens),
    receiptKinds: ['AgentExecutionReceipt'],
    provider: 'ollama',
  });
  return assertAgentExecutorPort({
    version: 1,
    kind: 'OllamaStructuredAgentExecutor',
    executorId,
    capabilities: () => capabilities,
    async execute(input = {}) {
      const { role, workspacePath, instructions, context = {}, requiredChecks = [], sandbox = 'workspace-write', outputTokenBudget = null, timeoutMs: requestedTimeout = null, signal = null } = input;
      const preflight = evaluateExecutorCapabilityRequest({ capabilities, request: capabilityRequestFromExecution({ ...input, sandbox, outputTokenBudget, timeoutMs: requestedTimeout }) });
      if (preflight.blockers.length) throw new Error(preflight.blockers.join(','));
      const workspace = path.resolve(workspacePath || '');
      if (!role || !instructions || !fs.existsSync(workspace)) throw new Error('role, instructions and workspacePath are required');
      const files = sourceFiles(workspace);
      let bytes = 0;
      const sources = [];
      for (const relative of files) {
        const content = fs.readFileSync(path.join(workspace, relative), 'utf8');
        if (bytes + Buffer.byteLength(content) > maximumContextBytes) continue;
        bytes += Buffer.byteLength(content);
        sources.push({ path: relative, content });
      }
      const effectiveOutputTokens = Math.max(128, Math.min(8192, Number(outputTokenBudget || maximumOutputTokens)));
      const prompt = [
        `Role: ${role}.`,
        String(instructions),
        'Return JSON only. Do not claim tools were used. Schema:',
        '{"status":"completed|blocked","summary":"...","edits":[{"path":"relative/path","content":"complete replacement content"}],"checks":["..."],"blockers":["..."]}',
        'Include any additional role-specific fields requested in the instructions at the top level.',
        `Keep the complete JSON response within ${effectiveOutputTokens} output tokens. Be concise.`,
        sandbox === 'read-only' ? 'This is read-only review: edits MUST be an empty array.' : 'Every edit must contain complete file content and use a relative path inside the workspace.',
        `Required checks for later pipeline stages: ${JSON.stringify(requiredChecks)}`,
        `Context: ${JSON.stringify(context)}`,
        `Files: ${JSON.stringify(sources)}`,
      ].join('\n\n');
      const promptHash = `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`;
      const sessionId = `ollama-exec:${crypto.randomUUID()}`;
      const startedAt = new Date().toISOString();
      const result = await runOllama({ ollamaHost, model, prompt, timeoutMs: Math.min(Number(requestedTimeout || timeoutMs), timeoutMs), maximumOutputTokens: effectiveOutputTokens, fetchImpl, signal });
      let response = null;
      try { response = JSON.parse(result.stdout); } catch { /* handled below */ }
      const blockers = [];
      if (result.exitCode !== 0 || result.error) blockers.push('ollama_agent_process_failed');
      if (result.doneReason === 'length') blockers.push('ollama_agent_output_truncated');
      if (!response || !Array.isArray(response.edits)) blockers.push('ollama_agent_invalid_json');
      if (sandbox === 'read-only' && response?.edits?.length) blockers.push('read_only_agent_returned_edits');
      const changedPaths = [];
      if (!blockers.length && sandbox !== 'read-only') {
        for (const edit of response.edits) {
          const destination = path.resolve(workspace, String(edit.path || ''));
          if (!edit.path || path.isAbsolute(edit.path) || !within(workspace, destination) || typeof edit.content !== 'string') {
            blockers.push('ollama_agent_edit_path_or_content_invalid');
            break;
          }
        }
        if (!blockers.length) {
          for (const edit of response.edits) {
            const destination = path.resolve(workspace, edit.path);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            const temporary = `${destination}.hepta-agent-${process.pid}.tmp`;
            fs.writeFileSync(temporary, edit.content);
            fs.renameSync(temporary, destination);
            changedPaths.push(edit.path.replace(/\\/g, '/'));
          }
        }
      }
      const completedAt = new Date().toISOString();
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        executorId,
        providerMode: 'local:ollama',
        model,
        resolvedModel: model,
        promptHash,
        sessionId,
        childSessionId: sessionId,
        maximumOutputTokens: effectiveOutputTokens,
        outputTokenCount: result.evalCount,
        outputDoneReason: result.doneReason,
        role,
        status: !blockers.length && response?.status !== 'blocked' ? 'agent_execution_completed' : 'agent_execution_failed',
        changedPaths: [...new Set(changedPaths)].sort(),
        summary: response?.summary || null,
        structuredOutput: response,
        finalOutput: result.stdout,
        checksRun: Array.isArray(response?.checks) ? response.checks : [],
        blockers: [...blockers, ...(Array.isArray(response?.blockers) ? response.blockers : [])],
        stdoutHash: `sha256:${crypto.createHash('sha256').update(result.stdout).digest('hex')}`,
        stderrHash: `sha256:${crypto.createHash('sha256').update(result.stderr).digest('hex')}`,
        stderrTail: result.stderr.slice(-4000),
        stdoutTail: result.stdout.slice(-4000),
        startedAt,
        completedAt,
        externalActionPerformed: false,
      };
      const receipt = Object.freeze({ ...payload, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload) });
      if (payload.status !== 'agent_execution_completed') {
        const error = new Error(payload.blockers.join(',') || 'ollama agent failed');
        error.retryable = true;
        error.receipt = receipt;
        throw error;
      }
      return receipt;
    },
  });
}
