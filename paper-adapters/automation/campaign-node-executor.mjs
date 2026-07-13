import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { requiredRevalidationForChanges } from '../../paper-domain/automation/referee-convergence.mjs';
import { datasetEnvironmentName, evaluateDatasetConsumptionContract, evaluateEmpiricalResultContract } from '../../paper-domain/automation/empirical-contract.mjs';
import { sanitizeGeneratedLatex } from './generated-latex-sanitizer.mjs';
import { runManuscriptQualityChecks } from './manuscript-quality-checks.mjs';
import { runTheoremManuscriptReadinessCheck } from './theorem-manuscript-readiness-check.mjs';
import { evaluateManuscriptPromotion } from '../../paper-domain/quality/manuscript-promotion-gate.mjs';

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

function agentInstructions(kind, manuscript, roundIndex, reviews = [], language = 'python', requiresGpu = false, datasetMounts = []) {
  if (kind === 'research-plan') return `Inspect ${manuscript} and the project. Write a concise RESEARCH_PLAN.md of at most 450 words with falsifiable claims, code tasks, datasets, metrics, baselines, ablations, seeds, and stopping criteria. Prefer compact tables or bullets over prose.`;
  if (kind === 'writer') return `Improve ${manuscript} according to RESEARCH_PLAN.md. Strengthen claims, related work, methods, limitations, and reproducibility without inventing results. Keep the complete manuscript concise enough for the configured output budget.`;
  if (/^coder(?:-|$)/.test(kind)) {
    const entrypoint = { python: 'experiments/run.py', r: 'experiments/run.R', node: 'experiments/run.mjs', julia: 'experiments/run.jl', lean: 'Main.lean' }[language] || `experiments/run.${language}`;
    const datasets = datasetMounts.length
      ? ` Declared datasets are mounted read-only inside the worker at ${datasetMounts.map((mount) => `/datasets/${mount.name} (${mount.licenseId})`).join(', ')}; use only those declared paths for external data.`
      : '';
    return `Implement the smallest valid ${entrypoint} for RESEARCH_PLAN.md${requiresGpu ? ' using the declared GPU runtime' : ''}. Use deterministic seeds, no network, and write results.json plus results.csv in the current working directory. Include a fast self-check in the same script. Do not fabricate outputs or add unnecessary framework code.${datasets}`;
  }
  if (kind === 'manuscript-integrate') return `Integrate only actually generated empirical artifacts from automation-results/ into ${manuscript}; update tables/figures and clearly distinguish observed results from planned work. For every inserted numeric empirical claim, add a nearby LaTeX comment of the exact form % HEPTA_RESULT relative/results.json#dot.path=value (or a results.csv column name after #) so deterministic provenance checks can verify it.`;
  if (/^referee-\d+$/.test(kind)) return `Independently review ${manuscript} before revision at round ${roundIndex}. Do not modify files. Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary.`;
  if (/^revision-referee-\d+$/.test(kind)) return `Independently review the revised ${manuscript} at round ${roundIndex}. Judge the current file, not a prior draft. Do not modify files. Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary.`;
  if (kind === 'revise') return `Revise ${manuscript} and relevant code to address the following independent reviews. Preserve correct content and run targeted checks. Preserve or update every % HEPTA_RESULT provenance marker when changing empirical claims. Reviews: ${JSON.stringify(reviews)}`;
  throw new Error(`No agent instructions for ${kind}`);
}

function outputTokenBudget(kind) {
  if (/^(?:revision-)?referee-\d+$/.test(kind)) return 1024;
  if (kind === 'research-plan') return 2048;
  if (/^coder(?:-|$)/.test(kind)) return 4096;
  if (['writer', 'manuscript-integrate', 'revise'].includes(kind)) return 8192;
  return 2048;
}

export function createCampaignNodeExecutor({ agentExecutor, empiricalExecutor, runtimeRoot, theoremQualityRevisionSink = null } = {}) {
  if (!agentExecutor || !empiricalExecutor || !runtimeRoot) throw new Error('agentExecutor, empiricalExecutor and runtimeRoot are required');
  return Object.freeze({
    version: 1,
    kind: 'CampaignNodeExecutor',
    async execute({ campaign, node, allNodes, executionBudget = {}, executionSignal = null, executionResources = null }) {
      const workspace = path.resolve(campaign.spec.sourceWorkspace);
      const manuscript = manuscriptPath(workspace);
      if (['research-plan', 'writer', 'manuscript-integrate', 'revise'].includes(node.kind) || /^coder(?:-|$)/.test(node.kind) || /^(?:revision-)?referee-\d+$/.test(node.kind)) {
        const reviews = allNodes.filter((item) => item.roundIndex === node.roundIndex && /^referee-\d+$/.test(item.kind)).map((item) => item.result).filter(Boolean);
        const receipt = await agentExecutor.execute({
          role: node.role || node.kind,
          workspacePath: workspace,
          instructions: agentInstructions(node.kind, manuscript, node.roundIndex, reviews, node.spec?.language || node.language || 'python', Boolean(node.spec?.requiresGpu || node.requiresGpu), campaign.spec.datasetMounts || []),
          context: { campaignId: campaign.campaign_id, nodeId: node.node_id, paperId: campaign.paper_id, roundIndex: node.roundIndex, datasetMounts: (campaign.spec.datasetMounts || []).map((mount) => ({ name: mount.name, workerPath: `/datasets/${mount.name}`, licenseId: mount.licenseId, manifestHash: mount.manifestHash })) },
          requiredChecks: /^coder(?:-|$)/.test(node.kind) ? ['run the new smoke test'] : node.kind === 'revise' ? ['rerun checks affected by changed files'] : [],
          sandbox: /^(?:revision-)?referee-\d+$/.test(node.kind) ? 'read-only' : 'workspace-write',
          outputTokenBudget: Math.min(outputTokenBudget(node.kind), Number(executionBudget.remainingTokenCount || outputTokenBudget(node.kind))),
          timeoutMs: executionBudget.remainingWallTimeMs,
          signal: executionSignal,
          isolationExcludes: (campaign.spec.datasetMounts || []).map((mount) => mount.source),
          isolationPolicy: { skipSourceSymlinks: true },
        });
        if (/^(?:revision-)?referee-\d+$/.test(node.kind)) {
          const parsed = receipt.structuredOutput || extractJson(receipt.finalOutput) || {};
          const manuscriptHash = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(workspace, manuscript))).digest('hex')}`;
          return Object.freeze({
            reviewerId: node.spec?.role || node.role || node.kind,
            role: node.spec?.role || node.role || node.kind,
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
            promptHash: receipt.promptHash || null,
            resolvedModel: receipt.resolvedModel || receipt.model || null,
            selectedExecutorId: receipt.selectedExecutorId || receipt.executorId || null,
          });
        }
        return receipt;
      }
      if (node.kind === 'convergence') {
        const theoremReadiness = runTheoremManuscriptReadinessCheck({
          workspacePath: workspace,
          manuscriptPath: manuscript,
          paperId: campaign.paper_id,
          profile: campaign.spec.paperQualityProfile || null,
        });
        const promotionGate = evaluateManuscriptPromotion({
          paperTask: { paperId: campaign.paper_id, taskKey: `${campaign.paper_id}:campaign` },
          profile: campaign.spec.paperQualityProfile || null,
          theoremReadiness,
          requirePaperQuality: false,
          boundary: 'automation_convergence',
        });
        const revisionMaterialization = theoremReadiness.passed ? null : theoremQualityRevisionSink?.record?.({ paperId: campaign.paper_id, report: theoremReadiness, sourceWorkspace: workspace }) || null;
        return {
          thresholds: campaign.spec.convergenceThresholds || {},
          qualityGates: [theoremReadiness, promotionGate],
          revisionMaterialization,
        };
      }
      if (['revalidate-citations', 'revalidate-artifacts'].includes(node.kind)) {
        const revise = allNodes.find((item) => item.roundIndex === node.roundIndex && item.kind === 'revise');
        const impact = requiredRevalidationForChanges(revise?.result?.changedPaths || []);
        if (!impact.required.includes(node.kind)) return { status: 'impact_revalidation_not_required', nodeKind: node.kind, changedPaths: revise?.result?.changedPaths || [] };
        const receipt = runManuscriptQualityChecks({
          workspacePath: workspace,
          manuscriptPath: manuscript,
          mode: node.kind === 'revalidate-citations' ? 'citations' : 'artifacts',
          requiresEmpiricalArtifacts: (campaign.spec.languages || []).some((language) => String(language).toLowerCase() !== 'latex'),
        });
        if (!receipt.passed) {
          const error = new Error(receipt.blockers.join(',') || 'manuscript_quality_check_failed');
          error.retryable = false;
          error.receipt = receipt;
          throw error;
        }
        return receipt;
      }
      const primaryEmpirical = /^empirical(?:$|-(?!reproduce(?:-|$)))/.test(node.kind);
      const reproduceEmpirical = /^empirical-reproduce(?:-|$)/.test(node.kind);
      const revalidateCode = /^revalidate-code(?:-|$)/.test(node.kind);
      const revalidateEmpirical = /^revalidate-empirical(?:-|$)/.test(node.kind);
      const empiricalKind = primaryEmpirical || reproduceEmpirical || revalidateCode || revalidateEmpirical || ['compile', 'package', 'revalidate-compile'].includes(node.kind);
      if (empiricalKind) {
        if (node.kind === 'package') {
          const readiness = runTheoremManuscriptReadinessCheck({
            workspacePath: workspace,
            manuscriptPath: manuscript,
            paperId: campaign.paper_id,
            profile: campaign.spec.paperQualityProfile || null,
          });
          const promotionGate = evaluateManuscriptPromotion({
            paperTask: { paperId: campaign.paper_id, taskKey: `${campaign.paper_id}:campaign` },
            profile: campaign.spec.paperQualityProfile || null,
            theoremReadiness: readiness,
            requirePaperQuality: false,
            boundary: 'automation_package',
          });
          if (!promotionGate.passed) {
            theoremQualityRevisionSink?.record?.({ paperId: campaign.paper_id, report: readiness, sourceWorkspace: workspace });
            const error = new Error(promotionGate.blockers.join(',') || 'manuscript_promotion_blocked');
            error.retryable = false;
            error.receipt = promotionGate;
            throw error;
          }
        }
        if (node.kind.startsWith('revalidate-')) {
          const revise = allNodes.find((item) => item.roundIndex === node.roundIndex && item.kind === 'revise');
          const impact = requiredRevalidationForChanges(revise?.result?.changedPaths || []);
          const required = revalidateCode ? impact.code : revalidateEmpirical ? impact.empirical : node.kind === 'revalidate-compile' ? impact.compile : true;
          if (!required) return { status: 'impact_revalidation_not_required', nodeKind: node.kind, changedPaths: revise?.result?.changedPaths || [] };
        }
        const language = ['compile', 'package', 'revalidate-compile'].includes(node.kind)
          ? 'latex'
          : (node.spec?.language || node.language || 'python');
        const entrypoint = empiricalEntrypoint(workspace, language);
        const outputDirectory = path.join(runtimeRoot, 'automation-artifacts', campaign.campaign_id.replace(/[^A-Za-z0-9_.-]/g, '_'), node.node_id.replace(/[^A-Za-z0-9_.-]/g, '_'));
        const datasetMounts = campaign.spec.datasetMounts || [];
        const datasetEnvironment = Object.fromEntries(datasetMounts.map((mount) => [datasetEnvironmentName(mount.name), `/datasets/${mount.name}`]));
        const empiricalSpec = {
          language,
          entrypoint,
          cwd: workspace,
          sourceRoot: workspace,
          outputDirectory,
          outputPaths: (primaryEmpirical || reproduceEmpirical || revalidateEmpirical)
            ? ['results.json', 'results.csv']
            : (language === 'latex' ? [manuscript.replace(/\.tex$/i, '.pdf')] : []),
          timeoutMs: Math.min(20 * 60 * 1000, Number(executionBudget.remainingWallTimeMs || 20 * 60 * 1000)),
          requiresGpu: Boolean((node.spec?.requiresGpu || node.requiresGpu || campaign.spec.requiresGpu) && language !== 'latex'),
          datasetMounts,
          env: { HEPTA_SEED: String(campaign.spec.seed || 42), HEPTA_OUTPUT_DIR: '/output', PYTHONHASHSEED: String(campaign.spec.seed || 42), OMP_NUM_THREADS: String(campaign.spec.ompThreads || 1), ...datasetEnvironment },
          memoryBytes: Number(campaign.spec.workerMemoryBytes || 4 * 1024 * 1024 * 1024),
          cpuSeconds: Number(campaign.spec.workerCpuSeconds || 3600),
          maximumProcesses: Number(campaign.spec.workerMaximumProcesses || 128),
          cachePolicy: reproduceEmpirical ? 'bypass' : 'default',
        };
        let repairReceipt = null;
        let sanitizerReceipt = null;
        let datasetConsumptionContract = null;
        if (language !== 'latex' && datasetMounts.length) {
          const entrypointPath = path.join(workspace, entrypoint);
          datasetConsumptionContract = evaluateDatasetConsumptionContract({
            sourceText: fs.existsSync(entrypointPath) ? fs.readFileSync(entrypointPath, 'utf8') : '',
            datasetMounts,
          });
          if (datasetConsumptionContract.blockers.length && !reproduceEmpirical) {
            const repair = ({ remainingTokenCount = 4096 } = {}) => agentExecutor.execute({
              role: 'dataset-consumption-contract-repair',
              workspacePath: workspace,
              instructions: `Repair ${entrypoint} so it consumes every declared read-only dataset from its worker path or environment variable: ${datasetConsumptionContract.evidence.map((item) => `${item.workerPath} via ${item.environmentName}`).join(', ')}. Remove any source-tree or host-specific input-data fallback. Preserve deterministic outputs and HEPTA_OUTPUT_DIR. Make the smallest valid change.`,
              context: { campaignId: campaign.campaign_id, paperId: campaign.paper_id, failedNode: node.kind, language, entrypoint, datasets: datasetConsumptionContract.evidence },
              requiredChecks: ['all declared datasets must be consumed through their read-only worker mount'],
              sandbox: 'workspace-write',
              outputTokenBudget: Math.min(4096, remainingTokenCount),
              signal: executionSignal,
              isolationExcludes: datasetMounts.map((mount) => mount.source),
              isolationPolicy: { skipSourceSymlinks: true },
            });
            repairReceipt = executionResources?.runNestedAgent ? await executionResources.runNestedAgent(repair) : await repair();
            datasetConsumptionContract = evaluateDatasetConsumptionContract({
              sourceText: fs.existsSync(entrypointPath) ? fs.readFileSync(entrypointPath, 'utf8') : '',
              datasetMounts,
            });
          }
          if (datasetConsumptionContract.blockers.length) {
            const error = new Error(datasetConsumptionContract.blockers.join(',') || 'dataset_consumption_contract_blocked');
            error.retryable = !reproduceEmpirical;
            error.receipt = datasetConsumptionContract;
            throw error;
          }
        }
        let result = empiricalExecutor.execute(empiricalSpec);
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
              isolationExcludes: (campaign.spec.datasetMounts || []).map((mount) => mount.source),
              isolationPolicy: { skipSourceSymlinks: true },
            });
            repairReceipt = executionResources?.runNestedAgent ? await executionResources.runNestedAgent(repair) : await repair();
            result = empiricalExecutor.execute(empiricalSpec);
          }
        }
        if (result.status !== 'empirical_execution_completed' && !infrastructureBlocked() && language !== 'latex') {
          const repair = ({ remainingTokenCount = 4096 } = {}) => agentExecutor.execute({
            role: 'empirical-code-repair',
            workspacePath: workspace,
            instructions: `Repair ${entrypoint} so the empirical command succeeds, its self-check passes, and it writes valid results.json and results.csv to HEPTA_OUTPUT_DIR (fall back to the process working directory). Do not hard-code an automation-results path or a prior node id. Make the smallest valid change. Runtime diagnostics:\n${String(result.stderrTail || result.stdoutTail || '').slice(-3000)}`,
            context: { campaignId: campaign.campaign_id, paperId: campaign.paper_id, failedNode: node.kind, language, entrypoint },
            requiredChecks: ['empirical command and self-check must pass after the repair'],
            sandbox: 'workspace-write',
            outputTokenBudget: Math.min(4096, remainingTokenCount),
            signal: executionSignal,
            isolationExcludes: (campaign.spec.datasetMounts || []).map((mount) => mount.source),
            isolationPolicy: { skipSourceSymlinks: true },
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
        let empiricalResultContract = null;
        if (primaryEmpirical || reproduceEmpirical || revalidateEmpirical) {
          const baselineNode = reproduceEmpirical
            ? allNodes.find((item) => node.dependencies.includes(item.node_id) && /^empirical(?:$|-(?!reproduce(?:-|$)))/.test(item.kind))
            : null;
          empiricalResultContract = evaluateEmpiricalResultContract({
            outputDirectory,
            metricSchema: campaign.spec.metricSchema || {},
            baselineMetrics: baselineNode?.result?.metricSnapshot || null,
          });
          if (empiricalResultContract.blockers.length && !reproduceEmpirical) {
            const repair = ({ remainingTokenCount = 4096 } = {}) => agentExecutor.execute({
              role: 'empirical-artifact-contract-repair',
              workspacePath: workspace,
              instructions: `Repair ${entrypoint} so a successful run writes valid results.json and results.csv to HEPTA_OUTPUT_DIR (fall back to the process working directory). Do not hard-code an automation-results path or a prior node id. Contract blockers: ${empiricalResultContract.blockers.join(', ')}`,
              context: { campaignId: campaign.campaign_id, paperId: campaign.paper_id, failedNode: node.kind, language, entrypoint },
              requiredChecks: ['the empirical command must create results.json and results.csv in HEPTA_OUTPUT_DIR'],
              sandbox: 'workspace-write',
              outputTokenBudget: Math.min(4096, remainingTokenCount),
              signal: executionSignal,
              isolationExcludes: (campaign.spec.datasetMounts || []).map((mount) => mount.source),
              isolationPolicy: { skipSourceSymlinks: true },
            });
            repairReceipt = executionResources?.runNestedAgent ? await executionResources.runNestedAgent(repair) : await repair();
            result = empiricalExecutor.execute(empiricalSpec);
            if (result.status === 'empirical_execution_completed') {
              empiricalResultContract = evaluateEmpiricalResultContract({
                outputDirectory,
                metricSchema: campaign.spec.metricSchema || {},
                baselineMetrics: baselineNode?.result?.metricSnapshot || null,
              });
            }
          }
          if (empiricalResultContract.blockers.length) {
            const error = new Error(empiricalResultContract.blockers.join(',') || 'empirical_result_contract_blocked');
            error.retryable = true;
            error.receipt = empiricalResultContract;
            throw error;
          }
        }
        const materialization = reproduceEmpirical
          ? { materializedPaths: [], automationArtifactMaterializationReceiptHash: null }
          : materializeArtifacts({ result, outputDirectory, workspace, nodeId: node.node_id });
        result = Object.freeze({
          ...result,
          metricSnapshot: empiricalResultContract?.metrics || [],
          empiricalResultContractReceiptHash: empiricalResultContract?.empiricalResultContractReceiptHash || null,
          empiricalResultContractStatus: empiricalResultContract?.status || null,
          datasetConsumptionContractReceiptHash: datasetConsumptionContract?.datasetConsumptionContractReceiptHash || null,
          datasetConsumptionStatus: datasetConsumptionContract?.status || null,
        });
        if (!repairReceipt && !sanitizerReceipt?.changed) return Object.freeze({ ...result, materializedPaths: materialization.materializedPaths, automationArtifactMaterializationReceiptHash: materialization.automationArtifactMaterializationReceiptHash });
        const payload = {
          version: 1,
          kind: 'AutomationRepairExecutionReceipt',
          nodeKind: node.kind,
          repairAgentReceiptHash: repairReceipt?.agentExecutionReceiptHash || null,
          generatedLatexSanitizerReceiptHash: sanitizerReceipt?.generatedLatexSanitizerReceiptHash || null,
          repairedExecutionReceiptHash: result.multiLanguageEmpiricalReceiptHash,
          language: result.language || language,
          runnerReceiptHash: result.runnerReceiptHash || null,
          artifacts: result.artifacts || [],
          isolation: result.isolation || {},
          containerImage: result.containerImage || null,
          datasetMounts: result.datasetMounts || [],
          cacheHit: Boolean(result.cacheHit),
          executionCacheKey: result.executionCacheKey || null,
          metricSnapshot: result.metricSnapshot,
          empiricalResultContractReceiptHash: result.empiricalResultContractReceiptHash,
          empiricalResultContractStatus: result.empiricalResultContractStatus,
          datasetConsumptionContractReceiptHash: result.datasetConsumptionContractReceiptHash,
          datasetConsumptionStatus: result.datasetConsumptionStatus,
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
