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

function boundedLeanFiles(root, maximum = 10) {
  const selected = [];
  const visit = (directory, relativeDirectory = '') => {
    if (selected.length >= maximum) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (selected.length >= maximum) break;
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!['.git', 'node_modules', '.lake', 'build'].includes(entry.name)) {
          visit(path.join(directory, entry.name), relative);
        }
      } else if (entry.isFile() && entry.name.endsWith('.lean')) {
        selected.push(relative);
      }
    }
  };
  visit(root);
  return selected;
}

function sourceFiles(root) {
  const preferred = [
    'THEOREM_SPEC.json', 'RESEARCH_WORKER_PLAN.json',
    'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json',
    'main.tex', 'paper.tex', 'manuscript.tex', 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
    'AUTONOMOUS_MANUSCRIPT_IR.json', 'RESEARCH_PLAN.md', 'references.bib',
    'lean-toolchain', 'lakefile.lean', 'lakefile.toml',
    'run.py', 'analysis.py', 'run.mjs', 'analysis.mjs',
    'run.R', 'analysis.R', 'run.jl', 'analysis.jl',
  ];
  const selected = preferred.filter((name) => fs.existsSync(path.join(root, name)));
  const experiments = fs.existsSync(path.join(root, 'experiments'))
    ? fs.readdirSync(path.join(root, 'experiments'), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `experiments/${entry.name}`).slice(0, 12)
    : [];
  return [...new Set([...selected, ...boundedLeanFiles(root), ...experiments])].slice(0, 20);
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

const FORMAL_REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['version', 'kind', 'theoremSpecificationHash', 'reviews'],
  properties: {
    version: { type: 'integer', enum: [1, 2] },
    kind: { type: 'string', enum: ['FormalClaimSemanticReview'] },
    theoremSpecificationHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    reviews: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: [
          'claimId', 'theoremName', 'manuscriptClaimHash', 'theoremTypeHash',
          'sourceStatementHash', 'status', 'semanticEquivalenceVerified', 'verdict',
        ],
        properties: {
          claimId: { type: 'string' },
          theoremName: { type: 'string' },
          manuscriptClaimHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          theoremTypeHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          sourceStatementHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          status: { type: 'string', enum: ['formal_semantic_review_verified', 'formal_semantic_review_rejected'] },
          semanticEquivalenceVerified: { type: 'boolean' },
          verdict: { type: 'string', enum: ['equivalent', 'not_equivalent'] },
          proposalClaimId: { type: 'string' },
          proposalClaimRecordHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          proposalClaimTextHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          proposalToTheoremSemanticVerified: { type: 'boolean' },
          proposalToTheoremVerdict: { type: 'string', enum: ['equivalent', 'not_equivalent'] },
          approvedNarrowingRationale: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
});

async function runOllama({
  ollamaHost,
  model,
  prompt,
  outputSchema,
  timeoutMs,
  maximumOutputTokens,
  fetchImpl,
  signal = null,
}) {
  const controller = new AbortController();
  let termination = null;
  const abort = () => {
    if (controller.signal.aborted) return;
    termination = 'external';
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) abort();
  if (termination === 'external') {
    return { exitCode: null, stdout: '', stderr: '', error: null, doneReason: null, promptEvalCount: null, evalCount: null, invocationStarted: false, aborted: true, timedOut: false };
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
        format: outputSchema,
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
        promptEvalCount: null,
        evalCount: null,
        invocationStarted: true,
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
      promptEvalCount: body.prompt_eval_count,
      evalCount: body.eval_count,
      invocationStarted: true,
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
      promptEvalCount: null,
      evalCount: null,
      invocationStarted: true,
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
  principalId = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20 * 60 * 1000,
  maximumContextBytes = 200000,
  maximumOutputTokens = 8192,
} = {}) {
  if (!model) throw new Error('Ollama model is required');
  const selectedPrincipalId = principalId === null || principalId === undefined
    ? null : String(principalId).trim();
  if (selectedPrincipalId
    && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(selectedPrincipalId)) {
    throw new Error('Ollama principalId is invalid');
  }
  const executorId = selectedPrincipalId
    ? `ollama-structured-agent-v1:${selectedPrincipalId}`
    : 'ollama-structured-agent-v1';
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
      workspaceMutationPolicy,
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
      const formalReviewMode = role === 'formal-review'
        || String(instructions).includes('FormalClaimSemanticReview');
      const outputSchema = formalReviewMode ? FORMAL_REVIEW_OUTPUT_SCHEMA : OUTPUT_SCHEMA;
      const prompt = [
        `Role: ${role}.`,
        String(instructions),
        formalReviewMode
          ? 'Return only the FormalClaimSemanticReview JSON document requested above. Do not add status, summary, edits, checks, blockers, Markdown, or prose.'
          : 'Return JSON only. Do not claim tools were used. Schema:',
        formalReviewMode ? ''
          : '{"status":"completed|blocked","summary":"...","edits":[{"path":"relative/path","content":"complete replacement content"}],"checks":["..."],"blockers":["..."]}',
        'Inside JSON string values, encode every literal backslash as \\\\; this is mandatory for TeX, code, and paths.',
        formalReviewMode ? ''
          : 'Include any additional role-specific fields requested in the instructions at the top level.',
        `Keep the complete JSON response within ${effectiveOutputTokens} output tokens. Be concise.`,
        formalReviewMode
          ? 'This is a read-only semantic review. Do not modify or propose edits to any file.'
          : sandbox === 'read-only'
            ? 'This is read-only review: edits MUST be an empty array.'
            : 'Every edit must contain complete file content and use a relative path inside the workspace.',
        workspaceMutationPolicy
          ? `The runtime enforces this exact workspace mutation policy: ${JSON.stringify(workspaceMutationPolicy)}`
          : '',
        `Required checks for later pipeline stages: ${JSON.stringify(requiredChecks)}`,
        `Context: ${JSON.stringify(context)}`,
        `Files: ${JSON.stringify(sources)}`,
      ].join('\n\n');
      const promptDigest = promptHash(prompt);
      const sessionId = `ollama-exec:${crypto.randomUUID()}`;
      const startedAt = new Date().toISOString();
      const result = await runOllama({
        ollamaHost,
        model,
        prompt,
        outputSchema,
        timeoutMs: Math.min(Number(requestedTimeout || timeoutMs), timeoutMs),
        maximumOutputTokens: effectiveOutputTokens,
        fetchImpl,
        signal,
      });
      const cancelled = isExternalAgentCancellation({
        ...result,
        aborted: result.aborted || signal?.aborted === true,
      });
      let response = null;
      if (!cancelled) {
        try { response = JSON.parse(result.stdout); } catch { /* handled below */ }
      }
      const usageReady = Number.isSafeInteger(result.promptEvalCount)
        && result.promptEvalCount >= 0
        && Number.isSafeInteger(result.evalCount)
        && result.evalCount >= 0;
      const usage = usageReady ? Object.freeze({
        cacheRead: 0,
        cacheWrite: 0,
        input: result.promptEvalCount,
        output: result.evalCount,
        totalTokens: result.promptEvalCount + result.evalCount,
      }) : null;
      const responseEdits = formalReviewMode ? [] : response?.edits;
      const blockers = [];
      if (cancelled) {
        blockers.push('ollama_agent_cancelled');
      } else {
        if (result.exitCode !== 0 || result.error) blockers.push('ollama_agent_process_failed');
        if (result.doneReason === 'length') blockers.push('ollama_agent_output_truncated');
        if (result.exitCode === 0 && !usageReady) blockers.push('ollama_agent_usage_invalid');
        if (formalReviewMode) {
          if (!response || response.kind !== 'FormalClaimSemanticReview'
            || ![1, 2].includes(response.version)
            || !/^sha256:[0-9a-f]{64}$/.test(String(response.theoremSpecificationHash || ''))
            || !Array.isArray(response.reviews) || !response.reviews.length) {
            blockers.push('ollama_agent_invalid_json');
          }
          if (sandbox !== 'read-only') blockers.push('ollama_formal_review_requires_read_only');
        } else {
          if (!response || !Array.isArray(responseEdits)) blockers.push('ollama_agent_invalid_json');
          if (sandbox === 'read-only' && responseEdits?.length) blockers.push('read_only_agent_returned_edits');
        }
      }
      const changedPaths = [];
      if (!blockers.length && sandbox !== 'read-only') {
        const edits = [];
        for (const edit of responseEdits) {
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
              if (destination.hash === postimageHash) continue;
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
      const responseBlockers = formalReviewMode
        ? [] : Array.isArray(response?.blockers) ? response.blockers : [];
      const payload = {
        providerMode: 'local:ollama',
        ...(selectedPrincipalId ? { agentId: selectedPrincipalId } : {}),
        model,
        resolvedModel: model,
        promptHash: promptDigest,
        sessionId,
        childSessionId: sessionId,
        maximumOutputTokens: effectiveOutputTokens,
        outputTokenCount: Number.isSafeInteger(result.evalCount) ? result.evalCount : 0,
        outputDoneReason: result.doneReason,
        role,
        status: !blockers.length && (formalReviewMode || response?.status !== 'blocked')
          ? 'agent_execution_completed' : 'agent_execution_failed',
        changedPaths: [...new Set(changedPaths)].sort(),
        summary: response?.summary || null,
        structuredOutput: response,
        finalOutput: result.stdout,
        checksRun: Array.isArray(response?.checks) ? response.checks : [],
        blockers: [...blockers, ...responseBlockers],
        stdoutHash: `sha256:${crypto.createHash('sha256').update(result.stdout).digest('hex')}`,
        stderrHash: `sha256:${crypto.createHash('sha256').update(result.stderr).digest('hex')}`,
        stderrTail: result.stderr.slice(-4000),
        stdoutTail: result.stdout.slice(-4000),
        startedAt,
        completedAt,
        externalModelInvocationPerformed: result.invocationStarted === true,
        usageComplete: usageReady,
        ...(usage ? { usage } : {}),
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
