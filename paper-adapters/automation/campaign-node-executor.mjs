import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sanitizeGeneratedLatex } from './generated-latex-sanitizer.mjs';

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

function agentInstructions(kind, manuscript, roundIndex, reviews = []) {
  if (kind === 'research-plan') return `Inspect ${manuscript} and the project. Write a concise RESEARCH_PLAN.md of at most 450 words with falsifiable claims, code tasks, datasets, metrics, baselines, ablations, seeds, and stopping criteria. Prefer compact tables or bullets over prose.`;
  if (kind === 'writer') return `Improve ${manuscript} according to RESEARCH_PLAN.md. Strengthen claims, related work, methods, limitations, and reproducibility without inventing results. Keep the complete manuscript concise enough for the configured output budget.`;
  if (kind === 'coder') return 'Implement the smallest valid experiments/run.py for RESEARCH_PLAN.md. Use deterministic seeds, no network, and write results.json plus results.csv in the current working directory. Include a fast self-check in the same script. Do not fabricate outputs or add unnecessary framework code.';
  if (kind === 'manuscript-integrate') return `Integrate only actually generated empirical artifacts into ${manuscript}; update tables/figures and clearly distinguish observed results from planned work.`;
  if (/^referee-\d+$/.test(kind)) return `Independently review ${manuscript} at round ${roundIndex}. Do not modify files. Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary.`;
  if (kind === 'revise') return `Revise ${manuscript} and relevant code to address the following independent reviews. Preserve correct content and run targeted checks. Reviews: ${JSON.stringify(reviews)}`;
  throw new Error(`No agent instructions for ${kind}`);
}

function outputTokenBudget(kind) {
  if (/^referee-\d+$/.test(kind)) return 1024;
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
    async execute({ campaign, node, allNodes }) {
      const workspace = path.resolve(campaign.spec.sourceWorkspace);
      const manuscript = manuscriptPath(workspace);
      if (['research-plan', 'writer', 'coder', 'manuscript-integrate', 'revise'].includes(node.kind) || /^referee-\d+$/.test(node.kind)) {
        const reviews = allNodes.filter((item) => item.roundIndex === node.roundIndex && /^referee-\d+$/.test(item.kind)).map((item) => item.result).filter(Boolean);
        const receipt = await agentExecutor.execute({
          role: node.role || node.kind,
          workspacePath: workspace,
          instructions: agentInstructions(node.kind, manuscript, node.roundIndex, reviews),
          context: { campaignId: campaign.campaign_id, paperId: campaign.paper_id, roundIndex: node.roundIndex },
          requiredChecks: node.kind === 'coder' ? ['run the new smoke test'] : node.kind === 'revise' ? ['rerun checks affected by changed files'] : [],
          sandbox: /^referee-\d+$/.test(node.kind) ? 'read-only' : 'workspace-write',
          outputTokenBudget: outputTokenBudget(node.kind),
        });
        if (/^referee-\d+$/.test(node.kind)) {
          const parsed = receipt.structuredOutput || extractJson(receipt.finalOutput) || {};
          return Object.freeze({
            reviewerId: node.role,
            verdict: parsed.verdict === 'accept' ? 'accept' : 'revise',
            score: Number(parsed.score || 0),
            criticalFindingCount: Number(parsed.criticalFindingCount || 0),
            findings: Array.isArray(parsed.findings) ? parsed.findings : [],
            summary: parsed.summary || receipt.finalOutput.slice(-1000),
            reviewHash: receipt.agentExecutionReceiptHash,
          });
        }
        return receipt;
      }
      if (node.kind === 'convergence') return { thresholds: campaign.spec.convergenceThresholds || {} };
      const empiricalKinds = new Set(['empirical', 'compile', 'package', 'revalidate-code', 'revalidate-empirical', 'revalidate-compile']);
      if (empiricalKinds.has(node.kind)) {
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
          timeoutMs: 20 * 60 * 1000,
          requiresGpu: Boolean(campaign.spec.requiresGpu && language !== 'latex'),
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
            repairReceipt = await agentExecutor.execute({
              role: 'latex-repair',
              workspacePath: workspace,
              instructions: `Repair ${manuscript} so latexmk succeeds. Make the smallest valid change and preserve correct content. Compiler diagnostics:\n${String(result.stderrTail || '').slice(-3000)}`,
              context: { campaignId: campaign.campaign_id, paperId: campaign.paper_id, failedNode: node.kind },
              requiredChecks: ['latexmk must succeed after the repair'],
              sandbox: 'workspace-write',
              outputTokenBudget: 4096,
            });
            result = empiricalExecutor.execute(empiricalSpec);
          }
        }
        if (result.status !== 'empirical_execution_completed' && !infrastructureBlocked() && language !== 'latex') {
          repairReceipt = await agentExecutor.execute({
            role: 'empirical-code-repair',
            workspacePath: workspace,
            instructions: `Repair ${entrypoint} so the empirical command succeeds, its self-check passes, and it writes valid results.json and results.csv. Make the smallest valid change. Runtime diagnostics:\n${String(result.stderrTail || result.stdoutTail || '').slice(-3000)}`,
            context: { campaignId: campaign.campaign_id, paperId: campaign.paper_id, failedNode: node.kind, language, entrypoint },
            requiredChecks: ['empirical command and self-check must pass after the repair'],
            sandbox: 'workspace-write',
            outputTokenBudget: 4096,
          });
          result = empiricalExecutor.execute(empiricalSpec);
        }
        if (result.status !== 'empirical_execution_completed') {
          const error = new Error(result.blockers?.join(',') || result.status);
          error.retryable = result.status !== 'empirical_runtime_unavailable';
          error.receipt = result;
          throw error;
        }
        if (!repairReceipt && !sanitizerReceipt?.changed) return result;
        const payload = {
          version: 1,
          kind: 'AutomationRepairExecutionReceipt',
          nodeKind: node.kind,
          repairAgentReceiptHash: repairReceipt?.agentExecutionReceiptHash || null,
          generatedLatexSanitizerReceiptHash: sanitizerReceipt?.generatedLatexSanitizerReceiptHash || null,
          repairedExecutionReceiptHash: result.multiLanguageEmpiricalReceiptHash,
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
