import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { requiredRevalidationForChanges } from '../../paper-domain/automation/referee-convergence.mjs';
import { sanitizeGeneratedLatex } from './generated-latex-sanitizer.mjs';
import { runManuscriptQualityChecks } from './manuscript-quality-checks.mjs';

function extractJson(text) {
  const source = String(text || '');
  const candidates = [...source.matchAll(/\{[\s\S]*?\}/g)].map((match) => match[0]).reverse();
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the previous candidate */ }
  }
  return null;
}

function manuscriptPath(workspace) {
  for (const name of ['main.tex', 'paper.tex', 'manuscript.tex']) {
    if (fs.existsSync(path.join(workspace, name))) return name;
  }
  return 'main.tex';
}

function empiricalEntrypoint(workspace, language) {
  const candidates = {
    python: ['experiments/run.py', 'analysis.py', 'run.py'],
    node: ['experiments/run.mjs', 'analysis.mjs'],
    r: ['experiments/run.R', 'analysis.R'],
    julia: ['experiments/run.jl', 'analysis.jl'],
    lean: [null],
    latex: [manuscriptPath(workspace)],
  }[language] || [];
  return candidates.find((candidate) => candidate === null || fs.existsSync(path.join(workspace, candidate))) || candidates[0] || null;
}

function materializeArtifacts({ result, outputDirectory, workspace, nodeId }) {
  const materialized = [];
  const base = path.join(workspace, 'automation-results', String(nodeId).replace(/[^A-Za-z0-9_.-]/g, '_'));
  for (const artifact of result.artifacts || []) {
    const source = path.join(outputDirectory, artifact.path);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const destination = path.join(base, artifact.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    materialized.push(path.relative(workspace, destination).replace(/\\/g, '/'));
  }
  const payload = {
    version: 1,
    kind: 'AutomationArtifactMaterializationReceipt',
    nodeId,
    sourceExecutionReceiptHash: result.multiLanguageEmpiricalReceiptHash || null,
    materializedPaths: materialized,
    status: 'automation_artifacts_materialized',
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, automationArtifactMaterializationReceiptHash: hashRecord('AutomationArtifactMaterializationReceipt', payload) });
}

function agentInstructions(kind, manuscript, roundIndex, reviews = []) {
  if (kind === 'research-plan') return `Inspect ${manuscript} and the project. Write a concise RESEARCH_PLAN.md of at most 450 words with falsifiable claims, code tasks, datasets, metrics, baselines, ablations, seeds, and stopping criteria. Prefer compact tables or bullets over prose.`;
  if (kind === 'writer') return `Improve ${manuscript} according to RESEARCH_PLAN.md. Strengthen claims, related work, methods, limitations, and reproducibility without inventing results. Keep the complete manuscript concise enough for the configured output budget.`;
  if (kind === 'coder') return 'Implement the smallest valid experiments/run.py for RESEARCH_PLAN.md. Use deterministic seeds, no network, and write results.json plus results.csv in the current working directory. Include a fast self-check in the same script. Do not fabricate outputs or add unnecessary framework code.';
  if (kind === 'manuscript-integrate') return `Integrate only actually generated empirical artifacts from automation-results/ into ${manuscript}; update tables/figures and clearly distinguish observed results from planned work. For every inserted numeric empirical claim, add a nearby LaTeX comment of the exact form % HEPTA_RESULT relative/results.json#dot.path=value (or a results.csv column name after #) so deterministic provenance checks can verify it.`;
  if (/^referee-\d+$/.test(kind)) return `Independently review ${manuscript} before revision at round ${roundIndex}. Do not modify files. Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary.`;
  if (/^revision-referee-\d+$/.test(kind)) return `Independently review the revised ${manuscript} at round ${roundIndex}. Judge the current file, not a prior draft. Do not modify files. Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary.`;
  if (kind === 'revise') return `Revise ${manuscript} and relevant code to address the following independent reviews. Preserve correct content and run targeted checks. Preserve or update every % HEPTA_RESULT provenance marker when changing empirical claims. Reviews: ${JSON.stringify(reviews)}`;
  throw new Error(`No agent instructions for ${kind}`);
}

function outputTokenBudget(kind) {
  if (/^(?:revision-)?referee-\d+$/.test(kind)) return 1024;
  if (kind === 'research-plan') return 2048;
  if (kind === 'coder') return 4096;
  if (['writer', 'manuscript-integrate', 'revise'].includes(kind)) return 8192;
  return 2048;
}

export function createCampaignNodeExecutor({ agentExecutor, empiricalExecutor, runtimeRoot } = {}) {
  if (!agentExecutor || !empiricalExecutor || !runtimeRoot) throw new Error('agentExecutor, empiricalExecutor and runtimeRoot are required');
  return Object.freeze({
    version: 1,
    kind: 'CampaignNodeExecutor',
    async execute({ campaign, node, allNodes, executionBudget = {}, executionSignal = null, executionResources = null }) {
      const workspace = path.resolve(campaign.spec.sourceWorkspace);
      const manuscript = manuscriptPath(workspace);
      if (['research-plan', 'writer', 'coder', 'manuscript-integrate', 'revise'].includes(node.kind) || /^(?:revision-)?referee-\d+$/.test(node.kind)) {
        const reviews = allNodes.filter((item) => item.roundIndex === node.roundIndex && /^referee-\d+$/.test(item.kind)).map((item) => item.result).filter(Boolean);
        const receipt = await agentExecutor.execute({
          role: node.role || node.kind,
          workspacePath: workspace,
          instructions: agentInstructions(node.kind, manuscript, node.roundIndex, reviews),
          context: { campaignId: campaign.campaign_id, nodeId: node.node_id, paperId: campaign.paper_id, roundIndex: node.roundIndex },
          requiredChecks: node.kind === 'coder' ? ['run the new smoke test'] : node.kind === 'revise' ? ['rerun checks affected by changed files'] : [],
          sandbox: /^(?:revision-)?referee-\d+$/.test(node.kind) ? 'read-only' : 'workspace-write',
          outputTokenBudget: Math.min(outputTokenBudget(node.kind), Number(executionBudget.remainingTokenCount || outputTokenBudget(node.kind))),
          timeoutMs: executionBudget.remainingWallTimeMs,
          signal: executionSignal,
        });
        if (/^(?:revision-)?referee-\d+$/.test(node.kind)) {
          const parsed = receipt.structuredOutput || extractJson(receipt.finalOutput) || {};
          const manuscriptHash = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(workspace, manuscript))).digest('hex')}`;
          return Object.freeze({
            reviewerId: node.role,
            verdict: parsed.verdict === 'accept' ? 'accept' : 'revise',
            score: Number(parsed.score || 0),
            criticalFindingCount: Number(parsed.criticalFindingCount || 0),
            findings: Array.isArray(parsed.findings) ? parsed.findings : [],
            summary: parsed.summary || receipt.finalOutput.slice(-1000),
            reviewHash: receipt.agentExecutionReceiptHash,
            manuscriptHash,
            childSessionId: receipt.sessionId || receipt.sessionKey || null,
            sessionKey: receipt.sessionKey || null,
            openClawRunId: receipt.openClawRunId || null,
            usage: receipt.usage || null,
            selectedExecutorId: receipt.selectedExecutorId || receipt.executorId || null,
          });
        }
        return receipt;
      }
      if (node.kind === 'convergence') return { thresholds: campaign.spec.convergenceThresholds || {} };
      if (['revalidate-citations', 'revalidate-artifacts'].includes(node.kind)) {
        const revise = allNodes.find((item) => item.roundIndex === node.roundIndex && item.kind === 'revise');
        const impact = requiredRevalidationForChanges(revise?.result?.changedPaths || []);
        if (!impact.required.includes(node.kind)) return { status: 'impact_revalidation_not_required', nodeKind: node.kind, changedPaths: revise?.result?.changedPaths || [] };
        const receipt = runManuscriptQualityChecks({ workspacePath: workspace, manuscriptPath: manuscript, mode: node.kind === 'revalidate-citations' ? 'citations' : 'artifacts' });
        if (!receipt.passed) {
          const error = new Error(receipt.blockers.join(',') || 'manuscript_quality_check_failed');
          error.retryable = false;
          error.receipt = receipt;
          throw error;
        }
        return receipt;
      }
      const empiricalKinds = new Set(['empirical', 'compile', 'package', 'revalidate-code', 'revalidate-empirical', 'revalidate-compile']);
      if (empiricalKinds.has(node.kind)) {
        if (node.kind.startsWith('revalidate-')) {
          const revise = allNodes.find((item) => item.roundIndex === node.roundIndex && item.kind === 'revise');
          const impact = requiredRevalidationForChanges(revise?.result?.changedPaths || []);
          if (!impact.required.includes(node.kind)) return { status: 'impact_revalidation_not_required', nodeKind: node.kind, changedPaths: revise?.result?.changedPaths || [] };
        }
        const language = ['compile', 'package', 'revalidate-compile'].includes(node.kind)
          ? 'latex'
          : (campaign.spec.languages?.[0] || 'python');
        const entrypoint = empiricalEntrypoint(workspace, language);
        const outputDirectory = path.join(runtimeRoot, 'automation-artifacts', campaign.campaign_id.replace(/[^A-Za-z0-9_.-]/g, '_'), node.node_id.replace(/[^A-Za-z0-9_.-]/g, '_'));
        const empiricalSpec = {
          language,
          entrypoint,
          cwd: workspace,
          sourceRoot: workspace,
          outputDirectory,
          outputPaths: node.kind.includes('empirical')
            ? ['results.json', 'results.csv']
            : (language === 'latex' ? [manuscript.replace(/\.tex$/i, '.pdf')] : []),
          timeoutMs: Math.min(20 * 60 * 1000, Number(executionBudget.remainingWallTimeMs || 20 * 60 * 1000)),
          requiresGpu: Boolean(campaign.spec.requiresGpu && language !== 'latex'),
          datasetMounts: campaign.spec.datasetMounts || [],
          env: { HEPTA_SEED: String(campaign.spec.seed || 42), PYTHONHASHSEED: String(campaign.spec.seed || 42), OMP_NUM_THREADS: String(campaign.spec.ompThreads || 1) },
          memoryBytes: Number(campaign.spec.workerMemoryBytes || 4 * 1024 * 1024 * 1024),
          cpuSeconds: Number(campaign.spec.workerCpuSeconds || 3600),
          maximumProcesses: Number(campaign.spec.workerMaximumProcesses || 128),
        };
        let result = empiricalExecutor.execute(empiricalSpec);
        let repairReceipt = null;
        let sanitizerReceipt = null;
        const infrastructureBlocked = () => (result.blockers || []).some((blocker) => /runtime_unavailable|sandbox_runtime_unavailable|gpu_required_but_unavailable/.test(blocker))
          || /can't find the format file|mktexfmt:/i.test(`${result.stderrTail || ''}\n${result.stdoutTail || ''}`);
        if (result.status !== 'empirical_execution_completed' && !infrastructureBlocked() && language === 'latex') {
          sanitizerReceipt = sanitizeGeneratedLatex({ workspacePath: workspace, manuscriptPath: manuscript });
          if (sanitizerReceipt.changed) result = empiricalExecutor.execute(empiricalSpec);
          if (result.status !== 'empirical_execution_completed') {
            const repair = ({ remainingTokenCount = 4096 } = {}) => agentExecutor.execute({
              role: 'latex-repair',
              workspacePath: workspace,
              instructions: `Repair ${manuscript} so latexmk succeeds. Make the smallest valid change and preserve correct content. Compiler diagnostics:\n${String(result.stderrTail || '').slice(-3000)}`,
              context: { campaignId: campaign.campaign_id, paperId: campaign.paper_id, failedNode: node.kind },
              requiredChecks: ['latexmk must succeed after the repair'],
              sandbox: 'workspace-write',
              outputTokenBudget: Math.min(4096, remainingTokenCount),
              signal: executionSignal,
            });
            repairReceipt = executionResources?.runNestedAgent ? await executionResources.runNestedAgent(repair) : await repair();
            result = empiricalExecutor.execute(empiricalSpec);
          }
        }
        if (result.status !== 'empirical_execution_completed' && !infrastructureBlocked() && language !== 'latex') {
          const repair = ({ remainingTokenCount = 4096 } = {}) => agentExecutor.execute({
            role: 'empirical-code-repair',
            workspacePath: workspace,
            instructions: `Repair ${entrypoint} so the empirical command succeeds, its self-check passes, and it writes valid results.json and results.csv. Make the smallest valid change. Runtime diagnostics:\n${String(result.stderrTail || result.stdoutTail || '').slice(-3000)}`,
            context: { campaignId: campaign.campaign_id, paperId: campaign.paper_id, failedNode: node.kind, language, entrypoint },
            requiredChecks: ['empirical command and self-check must pass after the repair'],
            sandbox: 'workspace-write',
            outputTokenBudget: Math.min(4096, remainingTokenCount),
            signal: executionSignal,
          });
          repairReceipt = executionResources?.runNestedAgent ? await executionResources.runNestedAgent(repair) : await repair();
          result = empiricalExecutor.execute(empiricalSpec);
        }
        if (result.status !== 'empirical_execution_completed') {
          const error = new Error(result.blockers?.join(',') || result.status);
          error.retryable = result.status !== 'empirical_runtime_unavailable';
          error.receipt = result;
          throw error;
        }
        const materialization = materializeArtifacts({ result, outputDirectory, workspace, nodeId: node.node_id });
        if (!repairReceipt && !sanitizerReceipt?.changed) return Object.freeze({ ...result, materializedPaths: materialization.materializedPaths, automationArtifactMaterializationReceiptHash: materialization.automationArtifactMaterializationReceiptHash });
        const payload = {
          version: 1,
          kind: 'AutomationRepairExecutionReceipt',
          nodeKind: node.kind,
          repairAgentReceiptHash: repairReceipt?.agentExecutionReceiptHash || null,
          generatedLatexSanitizerReceiptHash: sanitizerReceipt?.generatedLatexSanitizerReceiptHash || null,
          repairedExecutionReceiptHash: result.multiLanguageEmpiricalReceiptHash,
          materializedPaths: materialization.materializedPaths,
          automationArtifactMaterializationReceiptHash: materialization.automationArtifactMaterializationReceiptHash,
          status: 'automation_repair_execution_completed',
          externalActionPerformed: false,
        };
        return Object.freeze({ ...payload, automationRepairExecutionReceiptHash: hashRecord('AutomationRepairExecutionReceipt', payload) });
      }
      const payload = { version: 1, kind: 'CampaignNoopNodeReceipt', nodeKind: node.kind, status: 'campaign_node_completed', externalActionPerformed: false };
      return Object.freeze({ ...payload, receiptHash: hashRecord('CampaignNoopNodeReceipt', payload) });
    },
  });
}
