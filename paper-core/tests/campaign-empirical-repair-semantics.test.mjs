import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import {
  verifyAgentExecutionReceipt,
  verifyAgentWorkspacePostimageBinding,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  empiricalResultContractTechnicalRepairEligible,
  empiricalTechnicalRepairEligible,
} from '../../paper-application/automation/campaign-empirical-node-orchestrator.mjs';
import {
  assertLatexTechnicalRepairPreservesScientificContent,
} from '../../paper-application/automation/campaign-empirical-repair-policy.mjs';
import {
  buildCampaignEmpiricalSpec,
} from '../../paper-application/automation/campaign-empirical-spec-builder.mjs';
import {
  buildCampaignAgentExecutionRequest,
  empiricalCodeWorkspaceMutationPolicy,
} from '../../paper-application/automation/campaign-agent-policy.mjs';
import {
  assertOutcomeBoundBenchmarkSourceUnchanged,
  assertOutcomeBoundManuscriptMutationAllowed,
} from '../../paper-application/automation/campaign-confirmatory-lineage-policy.mjs';
import { buildCampaignModeNodes } from '../../paper-domain/automation/campaign-mode-graph.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  collectCampaignManuscriptAgentExecutionReceipts,
} from '../../paper-application/automation/campaign-manuscript-agent-receipts.mjs';

test('empirical auto-repair eligibility is technical-only and excludes scientific or authority outcomes', () => {
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_completed', scientificVerdict: 'negative', blockers: [],
  }, { language: 'python' }), false);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_completed', scientificVerdict: 'inconclusive',
    scientificFindings: ['analysis_independent_unit_count_insufficient'], blockers: [],
  }, { language: 'python' }), false);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_completed', blockers: ['os_sandbox_command_failed'],
    harnessExecutionReceipt: { analysisProtocolEvaluation: { scientificVerdict: 'inconclusive' } },
  }, { language: 'python' }), false);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_failed', failureClass: 'technical_failure', repairEligible: true,
    blockers: ['analysis_property_oracle_unverified'],
  }, { language: 'python' }), false);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_failed', blockers: ['os_sandbox_command_failed'],
  }, { language: 'python' }), true);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_failed', failureClass: 'technical_failure', repairEligible: true,
    blockers: ['benchmark_arm_adapter_unavailable:treatment:scoped_path_missing_or_unreadable'],
  }, { language: 'latex' }), false);
  assert.equal(empiricalTechnicalRepairEligible({
    status: 'empirical_execution_failed', blockers: ['os_sandbox_command_failed'],
  }, { language: 'latex' }), true);
  assert.equal(empiricalResultContractTechnicalRepairEligible({
    blockers: ['empirical_metric_inconsistent:mean_score'],
  }), false);
  assert.equal(empiricalResultContractTechnicalRepairEligible({
    blockers: ['empirical_results_json_missing', 'empirical_results_csv_missing'],
  }), true);
});

test('LaTeX technical repair preserves scientific tokens and rejects result changes', () => {
  const before = '\\documentclass{article}\nClaim score $\\mu=0.5$.\n\\end{document}\n';
  const receipt = assertLatexTechnicalRepairPreservesScientificContent({
    before,
    after: '\\documentclass{article}\n\\usepackage{amsmath}\nClaim score {$\\mu=0.5$}.\n\\end{document}\n',
    repairReceipt: { agentExecutionReceiptHash: `sha256:${'a'.repeat(64)}` },
  });
  assert.equal(receipt.status, 'latex_technical_repair_content_preserved');
  assert.throws(
    () => assertLatexTechnicalRepairPreservesScientificContent({
      before,
      after: '\\documentclass{article}\nClaim score $\\mu=0.9$.\n\\end{document}\n',
    }),
    (error) => error.retryable === false
      && error.message === 'campaign_latex_repair_scientific_content_changed'
      && error.receipt.status === 'latex_technical_repair_content_changed',
  );
});

test('LaTeX technical repair rejects deletion or rewriting of HEPTA authority markers', () => {
  const marker =
    '% HEPTA_EMPIRICAL_ASSERTION_BEGIN {"version":1,"assertionId":"fixture"}';
  const end = '% HEPTA_EMPIRICAL_ASSERTION_END fixture';
  const before = `\\documentclass{article}\n${marker}\nRegistered result is negative.\n${end}\n`;
  assert.throws(
    () => assertLatexTechnicalRepairPreservesScientificContent({
      before,
      after: '\\documentclass{article}\nRegistered result is negative.\n',
    }),
    (error) => error.retryable === false
      && error.message === 'campaign_latex_repair_authority_structure_changed'
      && error.receipt.status === 'latex_technical_repair_authority_structure_changed'
      && error.receipt.beforeAuthorityMarkerCount === 2
      && error.receipt.afterAuthorityMarkerCount === 0,
  );
  const receipt = assertLatexTechnicalRepairPreservesScientificContent({
    before,
    after: `\\documentclass{article}\n\\usepackage{microtype}\n${marker}\nRegistered result is negative.\n${end}\n`,
  });
  assert.equal(receipt.status, 'latex_technical_repair_content_preserved');
  assert.equal(receipt.beforeAuthorityStructureHash, receipt.afterAuthorityStructureHash);
  assert.throws(
    () => assertLatexTechnicalRepairPreservesScientificContent({
      before,
      after: `\\documentclass{article}\nRegistered result is negative.\n${marker}\n${end}\n`,
    }),
    (error) => error.retryable === false
      && error.message === 'campaign_latex_repair_authority_structure_changed',
  );
});

test('compile specs never inherit benchmark or dataset execution authority', () => {
  const built = buildCampaignEmpiricalSpec({
    primitives: {
      workspace: {
        findEmpiricalEntrypoint: () => 'main.tex',
        outputDirectory: () => '/tmp/hepta-compile-output',
        hashFile: () => `sha256:${'a'.repeat(64)}`,
      },
    },
    campaign: {
      campaignId: 'campaign',
      spec: {
        benchmarkId: 'finance_asset_pricing_benchmark',
        benchmarkSelector: { intentionallyInvalidIfConsumed: true },
        datasetMounts: [{
          name: 'must-not-reach-latex',
          source: '/datasets/private',
          readOnly: true,
        }],
      },
    },
    node: {
      nodeId: 'compile',
      kind: 'compile',
      attemptId: 'attempt-1',
      spec: { language: 'latex' },
    },
    context: {
      empirical: {
        empirical: true,
        compile: true,
        primary: false,
        reproduction: false,
        revalidate: false,
      },
    },
    workspace: '/workspace',
    manuscript: 'main.tex',
    executionBudget: {
      remainingWallTimeMs: 30_000,
      absoluteDeadlineEpochMs: Date.now() + 30_000,
    },
  });
  assert.equal(built.language, 'latex');
  assert.equal(built.benchmarkSelector, null);
  assert.deepEqual(built.datasetMounts, []);
  assert.equal(built.spec.benchmarkSelector, null);
  assert.deepEqual(built.spec.datasetMounts, []);
  assert.deepEqual(built.spec.outputPaths, ['main.pdf']);
  assert.equal(built.spec.requireSeparateOutputRoot, true);
  assert.equal(Object.keys(built.spec.env).some((key) => key.startsWith('HEPTA_DATASET_')), false);
  assert.equal('HEPTA_BENCHMARK_ID' in built.spec.env, false);
});

test('rejected LaTeX repair preserves the original execution blocker in a hashed failure receipt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-latex-repair-rejection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'main.tex'),
    '% HEPTA_EMPIRICAL_ASSERTION_BEGIN {"version":1,"assertionId":"fixture"}\n'
      + 'Registered result is negative.\n'
      + '% HEPTA_EMPIRICAL_ASSERTION_END fixture\n',
  );
  let empiricalCalls = 0;
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: {
      execute() {
        empiricalCalls += 1;
        return {
          version: 1,
          kind: 'MultiLanguageEmpiricalReceipt',
          language: 'latex',
          status: 'empirical_execution_failed',
          failureClass: 'technical_failure',
          repairEligible: true,
          blockers: ['os_sandbox_command_failed'],
          multiLanguageEmpiricalReceiptHash: `sha256:${'b'.repeat(64)}`,
          stderrTail: 'fixture LaTeX diagnostic',
        };
      },
    },
    agentExecutor: {
      async execute(input) {
        assert.equal(input.role, 'latex-repair');
        fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'Registered result is negative.\n');
        return { agentExecutionReceiptHash: `sha256:${'c'.repeat(64)}` };
      },
    },
  });
  await assert.rejects(
    () => executor.execute({
      campaign: {
        campaignId: 'campaign-latex-rejection',
        paperId: 'paper-latex-rejection',
        spec: {
          sourceWorkspace: root,
          manuscript: 'main.tex',
          languages: ['latex'],
          datasetMounts: [],
        },
      },
      node: {
        nodeId: 'compile',
        kind: 'compile',
        roundIndex: 0,
        spec: { language: 'latex' },
      },
      allNodes: [],
    }),
    (error) => {
      const {
        latexTechnicalRepairFailureReceiptHash,
        receiptHash,
        ...receiptPayload
      } = error.receipt;
      return error.retryable === false
        && error.message === 'campaign_latex_repair_authority_structure_changed'
        && error.receipt.kind === 'LatexTechnicalRepairFailureReceipt'
        && error.receipt.status === 'latex_technical_repair_rejected'
        && error.receipt.failedExecutionReceiptHash === `sha256:${'b'.repeat(64)}`
        && error.receipt.failedExecutionFailureClass === 'technical_failure'
        && error.receipt.failedExecutionRepairEligible === true
        && error.receipt.failedExecutionBlockers.includes('os_sandbox_command_failed')
        && /^sha256:[a-f0-9]{64}$/.test(error.receipt.failedExecutionDiagnosticHash)
        && /^sha256:[a-f0-9]{64}$/.test(error.receipt
          .latexTechnicalRepairContentPreservationReceiptHash)
        && /^sha256:[a-f0-9]{64}$/.test(latexTechnicalRepairFailureReceiptHash)
        && receiptHash === latexTechnicalRepairFailureReceiptHash
        && hashRecord('LatexTechnicalRepairFailureReceipt', receiptPayload)
          === latexTechnicalRepairFailureReceiptHash;
    },
  );
  assert.equal(empiricalCalls, 1);
});

test('coder agents receive an exact empirical-source allowlist and an outcome-blind workspace', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-coder-containment-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  fs.mkdirSync(path.join(root, 'automation-results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main.tex'), 'authoritative manuscript\n');
  fs.writeFileSync(path.join(root, 'automation-results', 'observed.json'), '{"effect":99}\n');
  const request = buildCampaignAgentExecutionRequest({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { datasetMounts: [] } },
    node: { nodeId: 'coder', kind: 'coder-python', role: 'coder-python', roundIndex: 0, language: 'python' },
    workspace: root,
    manuscript: 'main.tex',
    reviews: [],
    executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 30_000 },
  });
  assert.deepEqual(request.workspaceMutationPolicy.allowedPaths, ['experiments/run.py']);
  assert.deepEqual(request.workspaceMutationPolicy.allowedPrefixes, []);
  assert.deepEqual(request.workspaceMutationPolicy.allowedExtensions, []);
  assert.deepEqual(request.requiredCapabilities, { workspaceIsolation: true });
  assert.equal(request.isolationPolicy.outcomeBlind, true);
  assert.ok(request.isolationExcludes.includes(path.join(root, 'automation-results')));
  assert.deepEqual(empiricalCodeWorkspaceMutationPolicy({
    language: 'python', benchmarkSelector: {}, manuscript: 'main.tex',
  }).allowedPaths, [
    'experiments/run.py',
    'experiments/run.treatment.py',
    'experiments/run.baseline.py',
    'experiments/run.ablation.py',
  ]);
  const benchmarkRequest = buildCampaignAgentExecutionRequest({
    campaign: {
      campaignId: 'campaign', paperId: 'paper',
      spec: {
        datasetMounts: [],
        benchmarkSelector: buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark' }),
      },
    },
    node: { nodeId: 'coder-r', kind: 'coder-r', role: 'coder-r', roundIndex: 0, language: 'r' },
    workspace: root,
    manuscript: 'main.tex',
    reviews: [],
    executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 30_000 },
  });
  assert.match(benchmarkRequest.instructions, /one response object for every case as \{caseId:case\.caseId/);
  assert.match(benchmarkRequest.instructions, /never an array of bare scalars/);
  const delegate = {
    version: 1,
    kind: 'CoderContainmentFixtureAgent',
    executorId: 'coder-containment-fixture',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'coder-containment-fixture', sandboxModes: ['workspace-write'],
      networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      assert.equal(Object.hasOwn(input.context, 'sourceWorkspace'), false);
      assert.equal(Object.hasOwn(input, 'isolationExcludes'), false);
      assert.equal(input.context.outcomeBlindWorkspace, true);
      assert.equal(fs.existsSync(path.join(input.workspacePath, 'automation-results')), false);
      fs.mkdirSync(path.join(input.workspacePath, 'experiments'));
      fs.writeFileSync(path.join(input.workspacePath, 'experiments', 'run.py'), 'print("valid")\n');
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'coder rewrote manuscript\n');
      fs.writeFileSync(path.join(input.workspacePath, 'RESEARCH_PLAN.md'), 'coder rewrote protocol\n');
      fs.writeFileSync(path.join(input.workspacePath, 'THEOREM_SPEC.json'), '{}\n');
      fs.writeFileSync(path.join(input.workspacePath, 'Main.lean'), 'theorem forged : True := by trivial\n');
      fs.writeFileSync(path.join(input.workspacePath, 'package.json'), '{"scripts":{"test":"true"}}\n');
      fs.mkdirSync(path.join(input.workspacePath, 'automation-results'));
      fs.writeFileSync(path.join(input.workspacePath, 'automation-results', 'forged.json'), '{"effect":1}\n');
      return { status: 'agent_execution_completed', agentExecutionReceiptHash: 'sha256:fixture' };
    },
  };
  const isolated = createIsolatedAgentExecutor({
    delegate, isolationRoot: path.join(base, 'isolated'), keepFailedWorkspaces: false,
  });
  await assert.rejects(
    () => isolated.execute(request),
    (error) => error.retryable === false
      && /workspace_mutation_forbidden:main\.tex/.test(error.message)
      && /workspace_mutation_forbidden:RESEARCH_PLAN\.md/.test(error.message)
      && /workspace_mutation_forbidden:THEOREM_SPEC\.json/.test(error.message)
      && /workspace_mutation_not_allowlisted:Main\.lean/.test(error.message)
      && /workspace_mutation_not_allowlisted:package\.json/.test(error.message)
      && /workspace_mutation_system_owned:automation-results\/forged\.json/.test(error.message),
  );
  await assert.rejects(
    () => isolated.execute({
      workspacePath: root,
      role: 'coder-python',
      instructions: 'fixture',
      sandbox: 'workspace-write',
      isolationPolicy: { outcomeBlind: true },
    }),
    (error) => error.retryable === false
      && error.message === 'outcome_blind_writable_agent_mutation_policy_required',
  );
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'authoritative manuscript\n');
  assert.equal(fs.existsSync(path.join(root, 'experiments', 'run.py')), false);
});

test('outcome-informed revision cannot mutate empirical code or reopen confirmatory source repair', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-outcome-bound-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.tex'), 'negative result\n');
  fs.writeFileSync(path.join(source, 'run.py'), 'print("frozen")\n');
  const request = buildCampaignAgentExecutionRequest({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { datasetMounts: [] } },
    node: { nodeId: 'revise', kind: 'revise', role: 'reviser', roundIndex: 1 },
    workspace: source,
    manuscript: 'main.tex',
    reviews: [],
    empiricalOutcomeObserved: true,
    executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 30_000 },
  });
  assert.match(request.instructions, /negative, non-significant, or inconclusive result must remain reportable/i);
  assert.equal(request.context.empiricalOutcomeObserved, true);
  const delegate = {
    version: 1,
    kind: 'OutcomeMutationFixtureAgent',
    executorId: 'outcome-mutation-fixture',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'outcome-mutation-fixture', sandboxModes: ['workspace-write'],
      networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'faithful negative interpretation\n');
      fs.writeFileSync(path.join(input.workspacePath, 'run.py'), 'print("tuned after outcome")\n');
      return { status: 'agent_execution_completed', agentExecutionReceiptHash: 'sha256:fixture' };
    },
  };
  const isolated = createIsolatedAgentExecutor({
    delegate,
    isolationRoot: path.join(root, 'isolated'),
    keepFailedWorkspaces: false,
  });
  await assert.rejects(() => isolated.execute(request), /workspace_mutation_forbidden:run\.py/);
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'negative result\n');
  assert.equal(fs.readFileSync(path.join(source, 'run.py'), 'utf8'), 'print("frozen")\n');
  assert.equal(assertOutcomeBoundManuscriptMutationAllowed({
    changedPaths: ['main.tex', 'proof_status.md'], manuscript: 'main.tex',
  }), true);
  assert.throws(() => assertOutcomeBoundManuscriptMutationAllowed({
    changedPaths: ['main.tex', 'experiments/run.py'], manuscript: 'main.tex',
  }), (error) => error.message === 'campaign_outcome_informed_empirical_mutation_forbidden:experiments/run.py'
    && error.retryable === false);

  const hash = (character) => `sha256:${character.repeat(64)}`;
  const anchorFreeze = {
    analysisProtocolHash: hash('a'),
    systemBenchmarkArmProtocolSetHash: hash('b'),
    systemBenchmarkArmAdapterSetHash: hash('c'),
  };
  assert.equal(assertOutcomeBoundBenchmarkSourceUnchanged({
    anchorFreeze,
    analysisProtocolHash: hash('a'),
    systemBenchmarkArmProtocolSetHash: hash('b'),
    systemBenchmarkArmAdapterSetHash: hash('c'),
  }), true);
  assert.throws(() => assertOutcomeBoundBenchmarkSourceUnchanged({
    anchorFreeze,
    analysisProtocolHash: hash('a'),
    systemBenchmarkArmProtocolSetHash: hash('b'),
    systemBenchmarkArmAdapterSetHash: hash('d'),
  }), (error) => error.message === 'campaign_outcome_informed_empirical_source_mutation_forbidden'
    && error.retryable === false);
  const adapterSet = (readHash, sourceHash = hash('e')) => ({
    version: 1,
    kind: 'SystemBenchmarkArmAdapterSet',
    entrypointConvention: 'sibling-arm-entrypoints-v1',
    adapters: [{
      version: 1,
      kind: 'SystemBenchmarkArmAdapterIdentity',
      arm: 'treatment',
      relativePath: 'experiments/run.treatment.R',
      sourceHash,
      systemBenchmarkArmProtocolHash: hash('b'),
      sourceReadReceiptHash: readHash,
    }],
    systemBenchmarkArmAdapterSetHash: readHash,
  });
  assert.equal(assertOutcomeBoundBenchmarkSourceUnchanged({
    anchorFreeze,
    anchorArmAdapterSet: adapterSet(hash('c')),
    currentArmAdapterSet: adapterSet(hash('d')),
    analysisProtocolHash: hash('a'),
    systemBenchmarkArmProtocolSetHash: hash('b'),
    systemBenchmarkArmAdapterSetHash: hash('d'),
  }), true, 'volatile read-receipt identity must not look like source mutation');
  assert.throws(() => assertOutcomeBoundBenchmarkSourceUnchanged({
    anchorFreeze,
    anchorArmAdapterSet: adapterSet(hash('c')),
    currentArmAdapterSet: adapterSet(hash('d'), hash('f')),
    analysisProtocolHash: hash('a'),
    systemBenchmarkArmProtocolSetHash: hash('b'),
    systemBenchmarkArmAdapterSetHash: hash('d'),
  }), /campaign_outcome_informed_empirical_source_mutation_forbidden/);

  const nodes = buildCampaignModeNodes({
    campaignId: 'campaign', mode: 'full-campaign', rounds: 1, reviewers: 1,
    executionProfiles: [{ label: 'python', language: 'python', requiresGpu: false }],
    executionIntent: { mode: 'execute' }, empiricalRequested: true, applyManuscript: true,
  });
  const sealedKinds = nodes.filter((node) => /^(?:empirical-reproduce|revalidate-(?:code|empirical))/.test(node.kind));
  assert.ok(sealedKinds.length >= 4);
  assert.equal(sealedKinds.every((node) => node.sourceMutationPolicy === 'forbid'), true);
});

test('manuscript agents without empirical outcomes cannot claim observed evidence', () => {
  for (const kind of ['manuscript-integrate', 'revise']) {
    const request = buildCampaignAgentExecutionRequest({
      campaign: { campaignId: 'campaign', paperId: 'paper', spec: { datasetMounts: [] } },
      node: { nodeId: kind, kind, role: 'writer', roundIndex: 1 },
      workspace: '/tmp/no-empirical-outcome',
      manuscript: 'main.tex',
      reviews: [],
      empiricalOutcomeObserved: false,
      executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 30_000 },
    });
    assert.match(request.instructions, /No completed empirical outcome authority is present/);
    assert.match(request.instructions, /remove (?:any )?unsupported (?:observed results|empirical finding)/i);
    assert.doesNotMatch(request.instructions, /The empirical outcome is already observed/);
    assert.equal(request.context.empiricalOutcomeObserved, false);
  }
});

test('outcome-informed manuscript instructions expose only class-compatible evidence refs', () => {
  const empiricalAuthorityHash = `sha256:${'a'.repeat(64)}`;
  const proposalHash = `sha256:${'b'.repeat(64)}`;
  const empiricalEntryHash = `sha256:${'c'.repeat(64)}`;
  const theoremSpecificationHash = `sha256:${'d'.repeat(64)}`;
  const evidenceRefBindings = [{
    kind: 'proposal',
    hash: proposalHash,
    claimClasses: ['limitation', 'method', 'scope'],
  }, {
    kind: 'empirical_assertion_authority_entry',
    hash: empiricalEntryHash,
    claimClasses: ['interpretation'],
  }];
  const campaign = {
    campaignId: 'campaign-evidence-ref-bindings',
    paperId: 'paper-evidence-ref-bindings',
    spec: {
      datasetMounts: [],
      scientificClaimAuthority: {
        claimAuthorityType: 'machine-policy-authorized',
      },
    },
  };
  const requestInput = {
    campaign,
    node: {
      nodeId: 'campaign-evidence-ref-bindings:0:manuscript-integrate',
      kind: 'manuscript-integrate',
      role: 'writer',
      roundIndex: 0,
    },
    workspace: '/tmp/evidence-ref-bindings',
    manuscript: 'main.tex',
    reviews: [],
    empiricalAssertionAuthority: {
      empiricalAssertionAuthorityHash: empiricalAuthorityHash,
      entryCount: 1,
    },
    empiricalOutcomeObserved: true,
    executionBudget: { remainingTokenCount: 4096, remainingWallTimeMs: 60_000 },
  };
  const request = buildCampaignAgentExecutionRequest({
    ...requestInput,
    autonomousManuscriptEvidenceRefBindings: evidenceRefBindings,
  });
  assert.ok(request.instructions.includes(JSON.stringify(evidenceRefBindings)));
  assert.deepEqual(
    request.context.autonomousManuscriptEvidenceRefBindings,
    evidenceRefBindings,
  );
  assert.match(request.instructions, /only when that block's claimClass appears/i);
  assert.match(request.instructions, /THEOREM_SPEC\.json.*never manuscript evidenceRefs/i);
  assert.match(request.instructions,
    /formal_support as the sole formal theorem\/proof\/verification surface/i);
  assert.equal(request.instructions.includes(theoremSpecificationHash), false);
  assert.throws(
    () => buildCampaignAgentExecutionRequest(requestInput),
    /campaign_manuscript_evidence_ref_bindings_required/,
  );
});

test('contained mutation retries tell the agent which isolated path was discarded', () => {
  const request = buildCampaignAgentExecutionRequest({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { datasetMounts: [] } },
    node: {
      nodeId: 'revise', kind: 'revise', role: 'reviser', roundIndex: 1,
      attemptCount: 2,
      failureClass: 'workspace_mutation_not_allowlisted:RESEARCH_PLAN.md',
    },
    workspace: '/tmp/retry-feedback',
    manuscript: 'main.tex',
    reviews: [],
    executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 30_000 },
  });
  assert.match(request.instructions, /previous isolated attempt was discarded without merging/i);
  assert.match(request.instructions, /RESEARCH_PLAN\.md/);
  assert.match(request.instructions, /do not edit those paths/i);
});

test('outcome-informed agents can commit only the evidence-bound manuscript JSON draft', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-manuscript-ir-mutation-'));
  const root = path.join(base, 'source');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), 'system rendered manuscript\n');
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'),
    JSON.stringify({ version: 1, title: 'before' }));
  const request = buildCampaignAgentExecutionRequest({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { datasetMounts: [] } },
    node: { nodeId: 'integrate', kind: 'manuscript-integrate', role: 'writer', roundIndex: 0 },
    workspace: root,
    manuscript: 'main.tex',
    reviews: [],
    empiricalOutcomeObserved: true,
    executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 30_000 },
  });
  assert.ok(request.workspaceMutationPolicy.allowedPaths
    .includes('AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'));
  assert.equal(request.workspaceMutationPolicy.forbiddenExtensions.includes('.json'), false);
  const allowedDelegate = {
    version: 1,
    kind: 'EvidenceIrMutationFixtureAgent',
    executorId: 'evidence-ir-mutation-fixture',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'evidence-ir-mutation-fixture', sandboxModes: ['workspace-write'],
      networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      fs.writeFileSync(path.join(input.workspacePath, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'),
        JSON.stringify({ version: 1, title: 'agent-authored evidence prose' }));
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        status: 'agent_execution_completed',
        executorId: 'evidence-ir-mutation-fixture',
        agentId: 'evidence-author',
        changedPaths: ['AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'],
      };
      return Object.freeze({
        ...payload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
      });
    },
  };
  const allowedExecutor = createIsolatedAgentExecutor({
    delegate: allowedDelegate,
    isolationRoot: path.join(base, 'allowed-isolation'),
    keepFailedWorkspaces: false,
  });
  const receipt = await allowedExecutor.execute(request);
  assert.equal(verifyAgentExecutionReceipt(receipt), true);
  assert.equal(verifyAgentWorkspacePostimageBinding(receipt.agentWorkspacePostimageBinding), true);
  assert.match(fs.readFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'), 'utf8'),
    /agent-authored evidence prose/);

  const blockedDelegate = {
    ...allowedDelegate,
    executorId: 'unbound-json-mutation-fixture',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'unbound-json-mutation-fixture', sandboxModes: ['workspace-write'],
      networkPolicy: 'none', receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      fs.writeFileSync(path.join(input.workspacePath, 'UNBOUND_SCIENTIFIC_CLAIMS.json'), '{}');
      return { status: 'agent_execution_completed', agentExecutionReceiptHash: 'sha256:fixture' };
    },
  };
  const blockedExecutor = createIsolatedAgentExecutor({
    delegate: blockedDelegate,
    isolationRoot: path.join(base, 'blocked-isolation'),
    keepFailedWorkspaces: false,
  });
  await assert.rejects(
    () => blockedExecutor.execute(request),
    (error) => error.retryable === true
      && /workspace_mutation_not_allowlisted:UNBOUND_SCIENTIFIC_CLAIMS\.json/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(root, 'UNBOUND_SCIENTIFIC_CLAIMS.json')), false);
});

test('manuscript receipt history preserves nested agent evidence instead of campaign wrappers', () => {
  const agentReceipt = Object.freeze({
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    agentExecutionReceiptHash: 'sha256:agent-receipt',
  });
  const wrapper = Object.freeze({
    version: 1,
    kind: 'CampaignTrustedAutonomousManuscriptResult',
    status: 'campaign_trusted_autonomous_manuscript_completed',
    agentExecutionReceiptHash: agentReceipt.agentExecutionReceiptHash,
    agentExecutionReceipt: agentReceipt,
  });
  assert.deepEqual(collectCampaignManuscriptAgentExecutionReceipts([
    { result: wrapper },
  ], null), [agentReceipt]);
});

test('campaign executor repairs a failed empirical command before completing the node', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture');
  fs.writeFileSync(path.join(root, 'run.py'), 'raise RuntimeError("fixture")\n');
  let empiricalCalls = 0;
  const empiricalSpecs = [];
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: {
      execute(spec) {
        empiricalCalls += 1;
        empiricalSpecs.push(spec);
        assert.equal(spec.env.HEPTA_OUTPUT_DIR, '/output');
        assert.equal(spec.requireSeparateOutputRoot, true);
        if (empiricalCalls === 1) return {
          status: 'empirical_execution_failed',
          blockers: ['os_sandbox_command_failed'],
          stderrTail: 'RuntimeError: fixture; OBSERVED_EFFECT=99',
          stdoutTail: 'observed p=0.0001',
        };
        fs.mkdirSync(spec.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), JSON.stringify({ score: 1 }));
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.csv'), 'metric,value\nscore,1\n');
        return {
          status: 'empirical_execution_completed',
          multiLanguageEmpiricalReceiptHash: 'sha256:empirical',
          runnerReceiptHash: 'sha256:runner',
          artifacts: [],
          isolation: { gpuDeviceIsolationVerified: true },
          containerImage: 'fixture:locked',
          datasetMounts: [{ name: 'fixture', manifestHash: 'sha256:data', licenseId: 'MIT', readOnly: true }],
        };
      },
    },
    agentExecutor: {
      async execute(input) {
        assert.equal(input.role, 'empirical-code-repair');
        assert.doesNotMatch(input.instructions, /RuntimeError: fixture|OBSERVED_EFFECT|p=0\.0001/);
        assert.match(input.instructions, /Outcome-blind technical failure classes: command_failed/);
        assert.match(input.instructions, /Raw stdout, stderr, output artifacts, metric values, and observed scientific outcomes are intentionally withheld/);
        assert.match(input.instructions, /metric,value/);
        assert.match(input.instructions, /positive or significant result/i);
        assert.ok(input.isolationExcludes.includes(path.join(root, 'automation-results')));
        assert.equal(input.isolationPolicy.skipSourceSymlinks, true);
        assert.equal(input.isolationPolicy.outcomeBlind, true);
        assert.equal(input.context.outcomeBlindRepair, true);
        assert.match(input.context.empiricalOutcomeBlindRepairDiagnosticHash, /^sha256:[a-f0-9]{64}$/);
        assert.deepEqual(input.requiredCapabilities, { workspaceIsolation: true });
        assert.deepEqual(input.workspaceMutationPolicy.allowedPaths, ['run.py']);
        assert.deepEqual(input.workspaceMutationPolicy.allowedExtensions, []);
        return { agentExecutionReceiptHash: 'sha256:repair' };
      },
    },
  });
  const receipt = await executor.execute({
    campaign: { campaign_id: 'campaign', paper_id: 'paper', spec: { sourceWorkspace: root, languages: ['python'], datasetMounts: [] } },
    node: { node_id: 'node', kind: 'empirical', roundIndex: 0 },
    allNodes: [],
  });
  assert.equal(empiricalCalls, 2);
  assert.equal(empiricalSpecs[0].empiricalAttemptVersion, 1);
  assert.equal(empiricalSpecs[1].empiricalAttemptVersion, 2);
  assert.equal(empiricalSpecs[1].env.HEPTA_EXPERIMENT_ATTEMPT_ID, 'campaign:node:direct:v2');
  assert.equal(empiricalSpecs[1].failedAttemptLineageHashes.length, 1);
  assert.notEqual(empiricalSpecs[1].sourceLineageHash, empiricalSpecs[0].sourceLineageHash);
  assert.equal(receipt.status, 'automation_repair_execution_completed');
  assert.equal(receipt.empiricalAttemptVersion, 2);
  assert.equal(receipt.failedAttemptLineage.length, 1);
  assert.equal(receipt.failedAttemptLineage[0].failureClass, 'technical_failure');
  assert.equal(receipt.failedAttemptLineageHashes[0], receipt.failedAttemptLineage[0].empiricalFailedAttemptLineageHash);
  assert.equal(receipt.runnerReceiptHash, 'sha256:runner');
  assert.equal(receipt.containerImage, 'fixture:locked');
  assert.equal(receipt.isolation.gpuDeviceIsolationVerified, true);
  assert.equal(receipt.datasetMounts[0].manifestHash, 'sha256:data');
});

test('confirmatory or authorized-data execution failures never invoke a writable repair agent', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-confirmatory-repair-fail-closed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture\n');
  fs.writeFileSync(path.join(root, 'run.py'), 'import os\nopen(os.environ["HEPTA_DATASET_FIXTURE"], "rb").read(1)\n');
  let empiricalCalls = 0;
  let agentCalls = 0;
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: { execute() {
      empiricalCalls += 1;
      return {
        status: 'empirical_execution_failed',
        blockers: ['os_sandbox_command_failed'],
        stderrTail: 'partial outcome: effect=99, p=0.0001',
      };
    } },
    agentExecutor: { async execute() {
      agentCalls += 1;
      throw new Error('confirmatory repair agent must not run');
    } },
  });
  const datasetMount = {
    name: 'fixture', source: '/datasets/fixture', readOnly: true,
    manifestHash: `sha256:${'a'.repeat(64)}`, licenseId: 'MIT',
  };
  await assert.rejects(
    () => executor.execute({
      campaign: { campaignId: 'campaign', paperId: 'paper', spec: { sourceWorkspace: root, languages: ['python'], datasetMounts: [datasetMount] } },
      node: { nodeId: 'node', kind: 'empirical', roundIndex: 0, spec: { language: 'python' } },
      allNodes: [],
    }),
    (error) => error.retryable === false
      && error.message === 'campaign_confirmatory_writable_repair_fail_closed:empirical:empirical-code',
  );
  assert.equal(empiricalCalls, 1);
  assert.equal(agentCalls, 0);

  let timeoutAgentCalls = 0;
  fs.mkdirSync(path.join(root, 'timeout-runtime'), { recursive: true });
  const timeoutExecutor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'timeout-runtime'),
    empiricalExecutor: { execute() {
      return {
        status: 'empirical_execution_failed',
        blockers: ['benchmark_arm_batch_runner:treatment:os_sandbox_command_timed_out'],
      };
    } },
    agentExecutor: { async execute() {
      timeoutAgentCalls += 1;
      throw new Error('confirmatory timeout must retry frozen execution without writable repair');
    } },
  });
  await assert.rejects(
    () => timeoutExecutor.execute({
      campaign: { campaignId: 'timeout-campaign', paperId: 'paper', spec: { sourceWorkspace: root, languages: ['python'], datasetMounts: [datasetMount] } },
      node: { nodeId: 'timeout-node', kind: 'empirical', roundIndex: 0, spec: { language: 'python' } },
      allNodes: [],
    }),
    (error) => error.retryable === true
      && error.message === 'campaign_confirmatory_frozen_execution_retry_required:empirical:empirical-code',
  );
  assert.equal(timeoutAgentCalls, 0);

  let artifactAgentCalls = 0;
  fs.mkdirSync(path.join(root, 'artifact-runtime'), { recursive: true });
  const artifactExecutor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'artifact-runtime'),
    empiricalExecutor: { execute() {
      return {
        status: 'empirical_execution_completed',
        multiLanguageEmpiricalReceiptHash: `sha256:${'b'.repeat(64)}`,
        artifacts: [],
      };
    } },
    agentExecutor: { async execute() {
      artifactAgentCalls += 1;
      throw new Error('confirmatory artifact repair agent must not run');
    } },
  });
  await assert.rejects(
    () => artifactExecutor.execute({
      campaign: { campaignId: 'artifact-campaign', paperId: 'paper', spec: { sourceWorkspace: root, languages: ['python'], datasetMounts: [datasetMount], metricSchema: { minimumMetricCount: 1 } } },
      node: { nodeId: 'artifact-node', kind: 'empirical', roundIndex: 0, spec: { language: 'python' } },
      allNodes: [],
    }),
    (error) => error.retryable === false
      && error.message === 'campaign_confirmatory_writable_repair_fail_closed:empirical:empirical-artifact-contract',
  );
  assert.equal(artifactAgentCalls, 0);
});

test('campaign executor preserves a negative scientific outcome without invoking code repair', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-negative-empirical-outcome-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture\n');
  fs.writeFileSync(path.join(root, 'run.py'), 'print("negative fixture")\n');
  let empiricalCalls = 0;
  let agentCalls = 0;
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: { execute(spec) {
      empiricalCalls += 1;
      fs.mkdirSync(spec.outputDirectory, { recursive: true });
      fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), '{"effect":0}\n');
      fs.writeFileSync(path.join(spec.outputDirectory, 'results.csv'), 'metric,value\neffect,0\n');
      return {
        status: 'empirical_execution_completed',
        executionStatus: 'empirical_execution_completed',
        integrityStatus: 'empirical_integrity_verified',
        scientificVerdict: 'negative',
        scientificFindings: ['analysis_confirmatory_hypothesis_not_supported:fixture'],
        multiLanguageEmpiricalReceiptHash: `sha256:${'d'.repeat(64)}`,
        artifacts: [],
      };
    } },
    agentExecutor: { async execute() { agentCalls += 1; throw new Error('negative results must not trigger repair'); } },
  });
  const receipt = await executor.execute({
    campaign: { campaignId: 'negative-campaign', paperId: 'negative-paper', spec: { sourceWorkspace: root, languages: ['python'], metricSchema: { minimumMetricCount: 1 } } },
    node: { nodeId: 'negative-node', kind: 'empirical', roundIndex: 0, spec: { language: 'python' } },
    allNodes: [],
  });
  assert.equal(empiricalCalls, 1);
  assert.equal(agentCalls, 0);
  assert.equal(receipt.status, 'empirical_execution_completed');
  assert.equal(receipt.scientificVerdict, 'negative');
  assert.equal(receipt.empiricalResultContractStatus, 'empirical_result_schema_verified');
});

test('campaign executor repairs successful commands that violate the metric artifact contract', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-artifact-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main.tex'), 'fixture');
  fs.writeFileSync(path.join(root, 'run.R'), 'quit(status=0)\n');
  let calls = 0;
  let repaired = false;
  const artifactSpecs = [];
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    empiricalExecutor: { execute(spec) {
      calls += 1;
      artifactSpecs.push(spec);
      if (repaired) {
        fs.mkdirSync(spec.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), '{"metric":1}\n');
        fs.writeFileSync(path.join(spec.outputDirectory, 'results.csv'), 'metric,value\nmetric,1\n');
      }
      return { status: 'empirical_execution_completed', multiLanguageEmpiricalReceiptHash: `sha256:run-${calls}`, artifacts: [] };
    } },
    agentExecutor: { async execute(input) {
      assert.equal(input.role, 'empirical-artifact-contract-repair');
      assert.match(input.instructions, /HEPTA_OUTPUT_DIR/);
      assert.match(input.instructions, /metric,value/);
      assert.match(input.instructions, /positive\/significant result/i);
      assert.match(input.instructions, /Outcome-blind technical failure classes: metric_schema_unsatisfied, results_csv_missing, results_json_missing/);
      assert.doesNotMatch(input.instructions, /Contract blockers:/);
      assert.equal(input.context.outcomeBlindRepair, true);
      assert.match(input.context.empiricalOutcomeBlindRepairDiagnosticHash, /^sha256:[a-f0-9]{64}$/);
      assert.equal(input.isolationPolicy.outcomeBlind, true);
      assert.deepEqual(input.workspaceMutationPolicy.allowedPaths, ['experiments/run.R']);
      repaired = true;
      return { agentExecutionReceiptHash: 'sha256:artifact-repair' };
    } },
  });
  const receipt = await executor.execute({
    campaign: { campaign_id: 'campaign', paper_id: 'paper', spec: { sourceWorkspace: root, languages: ['r'], metricSchema: { minimumMetricCount: 1 } } },
    node: { node_id: 'node', kind: 'empirical', roundIndex: 0, spec: { language: 'r' } },
    allNodes: [],
  });
  assert.equal(calls, 2);
  assert.equal(artifactSpecs[0].empiricalAttemptVersion, 1);
  assert.equal(artifactSpecs[1].empiricalAttemptVersion, 2);
  assert.equal(artifactSpecs[1].failedAttemptLineageHashes.length, 1);
  assert.equal(receipt.status, 'automation_repair_execution_completed');
  assert.equal(receipt.empiricalAttemptVersion, 2);
  assert.equal(receipt.failedAttemptLineage.length, 1);
  assert.equal(receipt.empiricalResultContractStatus, 'empirical_result_schema_verified');
});
