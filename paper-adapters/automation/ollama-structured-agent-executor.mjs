import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentExecutorTemplate, isExternalAgentCancellation } from './agent-executor-template.mjs';
import {
  abortStagedScopedFileSync,
  commitStagedScopedFileSync,
  inspectScopedRegularFileSync,
  inspectScopedRegularFileWithRecoverySync,
  normalizeScopedRelativePath,
  stageScopedRegularFileCopySync,
} from '../runtime/scoped-file-materialization-repository.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

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
  let termination = null;
  const abort = () => {
    if (controller.signal.aborted) return;
    termination = 'external';
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) abort();
  if (termination === 'external') {
    return { exitCode: null, stdout: '', stderr: '', error: null, doneReason: null, evalCount: 0, aborted: true, timedOut: false };
  }
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    termination = 'timeout';
    controller.abort(new DOMException('ollama provider timed out', 'TimeoutError'));
  }, timeoutMs);
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
    if (termination) {
      const timedOut = termination === 'timeout';
      return {
        exitCode: null,
        stdout: '',
        stderr: timedOut ? 'ollama provider timed out' : '',
        error: timedOut ? new Error('ollama provider timed out') : null,
        doneReason: null,
        evalCount: 0,
        aborted: !timedOut,
        timedOut,
      };
    }
    return {
      exitCode: response.ok ? 0 : 1,
      stdout: String(body.response || ''),
      stderr: String(body.error || ''),
      error: response.ok ? null : new Error(body.error || `ollama_http_${response.status}`),
      doneReason: body.done_reason || null,
      evalCount: Number(body.eval_count || 0),
      aborted: false,
      timedOut: false,
    };
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: String(error?.message || error),
      error,
      doneReason: null,
      evalCount: 0,
      aborted: termination === 'external',
      timedOut: termination === 'timeout',
    };
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
  return createAgentExecutorTemplate({
    kind: 'OllamaStructuredAgentExecutor',
    executorId,
    capabilityDefinition: {
      networkPolicy: 'local-provider-only',
      maximumTimeoutMs: timeoutMs,
      maximumOutputTokens: Math.min(8192, maximumOutputTokens),
      provider: 'ollama',
    },
    workspaceValidationMessage: 'role, instructions and workspacePath are required',
    requireDirectory: false,
    async executeStrategy({
      role,
      instructions,
      context,
      requiredChecks,
      sandbox,
      outputTokenBudget,
      requestedTimeout,
      signal,
      workspace,
      promptHash,
    }) {
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
      const promptDigest = promptHash(prompt);
      const sessionId = `ollama-exec:${crypto.randomUUID()}`;
      const startedAt = new Date().toISOString();
      const result = await runOllama({ ollamaHost, model, prompt, timeoutMs: Math.min(Number(requestedTimeout || timeoutMs), timeoutMs), maximumOutputTokens: effectiveOutputTokens, fetchImpl, signal });
      const cancelled = isExternalAgentCancellation({
        ...result,
        aborted: result.aborted || signal?.aborted === true,
      });
      let response = null;
      if (!cancelled) {
        try { response = JSON.parse(result.stdout); } catch { /* handled below */ }
      }
      const blockers = [];
      if (cancelled) {
        blockers.push('ollama_agent_cancelled');
      } else {
        if (result.exitCode !== 0 || result.error) blockers.push('ollama_agent_process_failed');
        if (result.doneReason === 'length') blockers.push('ollama_agent_output_truncated');
        if (!response || !Array.isArray(response.edits)) blockers.push('ollama_agent_invalid_json');
        if (sandbox === 'read-only' && response?.edits?.length) blockers.push('read_only_agent_returned_edits');
      }
      const changedPaths = [];
      if (!blockers.length && sandbox !== 'read-only') {
        const edits = [];
        for (const edit of response.edits) {
          try {
            const relative = normalizeScopedRelativePath(edit.path);
            const destination = path.resolve(workspace, ...relative.split('/'));
            if (path.isAbsolute(edit.path) || !isPathWithin(workspace, destination) || typeof edit.content !== 'string') throw new Error('invalid edit');
            inspectScopedRegularFileSync({ scopeRoot: workspace, relative });
            edits.push({ relative, content: edit.content });
          } catch {
            blockers.push('ollama_agent_edit_path_or_content_invalid');
            break;
          }
        }
        if (!blockers.length) {
          const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-ollama-edit-'));
          try {
            for (const [index, edit] of edits.entries()) {
              const sourceRelative = `edit-${index}`;
              fs.writeFileSync(path.join(stagingRoot, sourceRelative), edit.content);
              const destination = inspectScopedRegularFileWithRecoverySync({ scopeRoot: workspace, relative: edit.relative });
              const postimageHash = `sha256:${crypto.createHash('sha256').update(edit.content).digest('hex')}`;
              if (destination.hash === postimageHash) {
                changedPaths.push(edit.relative);
                continue;
              }
              const staged = stageScopedRegularFileCopySync({
                sourceRoot: stagingRoot,
                destinationRoot: workspace,
                relative: sourceRelative,
                destinationRelative: edit.relative,
                stageId: `ollama-edit:${crypto.createHash('sha256').update(`${edit.relative}\0${postimageHash}\0${destination.hash}`).digest('hex')}`,
                expectedHash: destination.hash,
              });
              try {
                commitStagedScopedFileSync(staged, { destinationRoot: workspace, expectedHash: destination.hash });
              } catch (error) {
                abortStagedScopedFileSync(staged);
                throw error;
              }
              changedPaths.push(edit.relative);
            }
          } catch {
            blockers.push('ollama_agent_edit_path_or_content_invalid');
          } finally {
            fs.rmSync(stagingRoot, { recursive: true, force: true });
          }
        }
      }
      const completedAt = new Date().toISOString();
      const payload = {
        providerMode: 'local:ollama',
        model,
        resolvedModel: model,
        promptHash: promptDigest,
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
        externalActionVerification: 'local_provider_without_agent_tools',
      };
      return {
        payload,
        failureMessage: payload.blockers.join(',') || 'ollama agent failed',
        retryable: !cancelled,
      };
    },
  });
}
