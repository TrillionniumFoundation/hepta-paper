import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { finalizeCampaignFormalWorkerPlan } from '../../paper-adapters/automation/campaign-formal-worker-plan-finalizer.mjs';
import { finalizeTheoremSpecification } from '../../paper-adapters/automation/theorem-specification-finalizer.mjs';
import { leanSourceDeclarationRecords } from '../../paper-adapters/research-verify/lean-source-contracts.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { manuscriptClaimHash } from '../../paper-domain/research/formal-claim-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

function agentReceipt({ agentId, role, structuredOutput = null, changedPaths = [] } = {}) {
  const usage = Object.freeze({
    input: 5,
    inputTokens: 5,
    input_tokens: 5,
    output: 3,
    outputTokens: 3,
    output_tokens: 3,
    cacheRead: 2,
    cacheReadTokens: 2,
    cache_read_tokens: 2,
    cacheWrite: 0,
    cacheWriteTokens: 0,
    cache_write_tokens: 0,
    totalTokens: 10,
    total_tokens: 10,
    total: 10,
    costUsd: 0.01,
    cost_usd: 0.01,
  });
  const payload = {
    status: 'agent_execution_completed',
    providerMode: 'openclaw:detached-child-session',
    executorId: 'formal-candidate-fixture-v1',
    agentId,
    agentCapabilityProfileHash: hashRecord('AgentCapabilityProfileFixture', { agentId }),
    openClawAgentConfigurationHash: hashRecord('OpenClawAgentConfigurationFixture', { agentId }),
    openClawGatewayConfigurationHash: hashRecord('OpenClawGatewayConfigurationFixture', { gateway: 'fixture' }),
    resolvedModel: 'fixture-model',
    role,
    changedPaths,
    structuredOutput,
    finalOutput: structuredOutput ? JSON.stringify(structuredOutput) : '',
    externalActionPerformed: false,
    externalModelInvocationPerformed: true,
    usageComplete: true,
    usage,
  };
  return Object.freeze({ ...payload, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload) });
}

test('theorem specification finalization rejects draft and canonical-spec symlink escapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-spec-symlink-'));
  const workspace = path.join(root, 'source');
  const outsideDraft = path.join(root, 'outside-draft.json');
  const outsideSpec = path.join(root, 'outside-spec.json');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'main.tex'), [
    '\\begin{theorem}True.\\end{theorem}',
    '\\begin{proof}Immediate.\\end{proof}',
    '',
  ].join('\n'));
  fs.writeFileSync(outsideDraft, '{}\n');
  fs.writeFileSync(outsideSpec, '{}\n');
  fs.symlinkSync(outsideDraft, path.join(workspace, 'THEOREM_SPEC_DRAFT.json'));
  assert.throws(() => finalizeTheoremSpecification({
    workspace, manuscriptPath: 'main.tex', paperId: 'paper', campaignId: 'campaign',
  }), /theorem_specification_draft_required/);
  assert.equal(fs.readFileSync(outsideDraft, 'utf8'), '{}\n');

  fs.rmSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'));
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), '{}\n');
  fs.symlinkSync(outsideSpec, path.join(workspace, 'THEOREM_SPEC.json'));
  assert.throws(() => finalizeTheoremSpecification({
    workspace, manuscriptPath: 'main.tex', paperId: 'paper', campaignId: 'campaign',
  }), /theorem_specification_canonical_path_invalid/);
  assert.equal(fs.readFileSync(outsideSpec, 'utf8'), '{}\n');
});

test('system finalization replaces an empty model-authored worker plan with canonical Lean bindings', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-worker-plan-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const statement = 'For every natural number n, n equals n.';
  fs.writeFileSync(path.join(workspace, 'main.tex'), [
    `\\begin{theorem}${statement}\\end{theorem}`,
    '\\begin{proof}By reflexivity.\\end{proof}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), `${JSON.stringify({
    version: 1,
    kind: 'TheoremSpecificationDraft',
    claims: [{
      claimKey: 'reflexive', title: 'Reflexive equality', statement,
      assumptions: [], quantifiers: ['For every natural number n.'],
      negativeBoundaries: ['No equality of distinct values is claimed.'],
      proofObligations: ['reflexiveIdentity'], evidenceObligations: [], manuscriptIntent: 'existing',
    }],
  }, null, 2)}\n`);
  finalizeTheoremSpecification({
    workspace, manuscriptPath: 'main.tex', paperId: 'paper', campaignId: 'campaign',
  });
  fs.writeFileSync(
    path.join(workspace, 'FormalProof.lean'),
    'theorem reflexiveIdentity (n : Nat) : n = n := by rfl\n',
  );
  fs.writeFileSync(path.join(workspace, 'RESEARCH_WORKER_PLAN.json'), `${JSON.stringify({
    version: 1, kind: 'ResearchWorkerPlan', paperId: null, taskKey: null, workers: [],
  })}\n`);
  fs.writeFileSync(path.join(workspace, 'lean-toolchain'), 'leanprover/lean4:v4.18.0\n');

  const theoremSpecification = JSON.parse(
    fs.readFileSync(path.join(workspace, 'THEOREM_SPEC.json'), 'utf8'),
  );
  const result = finalizeCampaignFormalWorkerPlan({
    workspace,
    paperId: 'paper',
    taskKey: 'paper_factory:paper',
    theoremSpecification,
  });
  const persisted = JSON.parse(
    fs.readFileSync(path.join(workspace, 'RESEARCH_WORKER_PLAN.json'), 'utf8'),
  );

  assert.equal(result.status, 'formal_worker_plan_system_finalized');
  assert.equal(persisted.kind, 'NativeResearchWorkerPlan');
  assert.equal(persisted.paperId, 'paper');
  assert.equal(persisted.taskKey, 'paper_factory:paper');
  assert.equal(persisted.workers.length, 1);
  assert.equal(persisted.workers[0].inputs[0].path, 'FormalProof.lean');
  assert.equal(
    persisted.workers[0].parameters.claimBindings[0].theoremName,
    'reflexiveIdentity',
  );
  assert.equal(
    persisted.workers[0].parameters.claimBindings[0].claimId,
    theoremSpecification.claims[0].claimId,
  );
  const claim = theoremSpecification.claims[0];
  const binding = persisted.workers[0].parameters.claimBindings[0];
  const sourceLocator = `${claim.manuscriptSource.path}#bytes=${claim.manuscriptSource.byteStart}-${claim.manuscriptSource.byteEnd}`;
  assert.equal(
    binding.manuscriptClaimHash,
    manuscriptClaimHash({
      claimId: claim.claimId,
      text: claim.statement,
      sourceLocator,
    }),
  );
  assert.notEqual(
    binding.manuscriptClaimHash,
    claim.manuscriptSource.contentHash,
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, 'lean-toolchain'), 'utf8'),
    'leanprover/lean4:v4.30.0\n',
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(workspace, 'lake-manifest.json'), 'utf8')),
    { version: '1.1.0', packagesDir: '.lake/packages', packages: [] },
  );
});

function fixture(t, { completeAfterIteration = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-candidate-'));
  const workspace = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statement = 'For every natural number n, n equals n.';
  fs.writeFileSync(path.join(workspace, 'main.tex'), [
    `\\begin{theorem}${statement}\\end{theorem}`,
    '\\begin{proof}By reflexivity.\\end{proof}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'Main.lean'), 'before\n');
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), `${JSON.stringify({
    version: 1,
    kind: 'TheoremSpecificationDraft',
    claims: [{
      claimKey: 'reflexive', title: 'Reflexive equality', statement,
      assumptions: [], quantifiers: ['For every natural number n.'],
      negativeBoundaries: ['No equality of distinct values is claimed.'],
      proofObligations: ['reflexiveIdentity'], evidenceObligations: [], manuscriptIntent: 'existing',
    }],
  }, null, 2)}\n`);
  finalizeTheoremSpecification({
    workspace, manuscriptPath: 'main.tex', paperId: 'paper', campaignId: 'campaign',
  });
  const leanSource = 'theorem reflexiveIdentity (n : Nat) : n = n := by rfl\n';
  let authorCalls = 0;
  let reviewerCalls = 0;
  const authorInputs = [];
  const reviewerReceiptHashes = [];
  const verifierInputs = [];

  const writeFormalCandidate = (input) => {
    authorCalls += 1;
    const specification = JSON.parse(fs.readFileSync(path.join(input.workspacePath, 'THEOREM_SPEC.json'), 'utf8'));
    const claim = specification.claims[0];
    const repairComment = input.role === 'formal-proof-repair' ? `-- repair ${authorCalls}\n` : '';
    const source = `${repairComment}${leanSource}`;
    const declaration = leanSourceDeclarationRecords(source).find((item) => item.name === 'reflexiveIdentity');
    fs.writeFileSync(path.join(input.workspacePath, 'Main.lean'), source);
    fs.writeFileSync(path.join(input.workspacePath, 'RESEARCH_WORKER_PLAN.json'), `${JSON.stringify({
      version: 1,
      kind: 'NativeResearchWorkerPlan',
      paperId: 'paper',
      taskKey: 'paper_factory:paper',
      workers: [{
        id: 'lean-proof', type: 'formal_verifier_lake', evidenceClass: 'research_evidence',
        syntheticInput: false, outcomesPreprogrammed: false, claimIds: [claim.claimId],
        inputs: [{ role: 'formal_source', path: 'Main.lean', sha256: hashBytes(Buffer.from(source)) }],
        parameters: {
          projectRoot: '.', executable: 'lake',
          claimBindings: [{
            claimId: claim.claimId,
            theoremSpecificationHash: specification.theoremSpecificationHash,
            theoremSpecificationClaimHash: claim.theoremSpecificationClaimHash,
            theoremName: 'reflexiveIdentity', sourceFile: 'Main.lean',
            expectedTypeHash: declaration.typeHash, sourceStatementHash: declaration.statementHash,
            proofObligations: claim.proofObligations,
            manuscriptSource: {
              path: claim.manuscriptSource.path,
              byteStart: claim.manuscriptSource.byteStart,
              byteEnd: claim.manuscriptSource.byteEnd,
              contentHash: claim.manuscriptSource.contentHash,
            },
          }],
        },
      }],
    }, null, 2)}\n`);
    return agentReceipt({
      agentId: 'formal-author', role: input.role,
      changedPaths: ['Main.lean', 'RESEARCH_WORKER_PLAN.json'],
    });
  };
  const agentExecutor = {
    async execute(input) {
      if (!['formal-author', 'formal-proof-repair'].includes(input.role)) {
        throw new Error(`unexpected_formal_candidate_role:${input.role}`);
      }
      authorInputs.push(input);
      return writeFormalCandidate(input);
    },
  };
  const formalReviewAgentExecutor = {
    async execute(input) {
      reviewerCalls += 1;
      const specification = JSON.parse(fs.readFileSync(path.join(input.workspacePath, 'THEOREM_SPEC.json'), 'utf8'));
      const claim = specification.claims[0];
      const plan = JSON.parse(fs.readFileSync(path.join(input.workspacePath, 'RESEARCH_WORKER_PLAN.json'), 'utf8'));
      const binding = plan.workers[0].parameters.claimBindings[0];
      const sourceLocator = `${claim.manuscriptSource.path}#bytes=${claim.manuscriptSource.byteStart}-${claim.manuscriptSource.byteEnd}`;
      assert.equal(plan.workers[0].id, 'system-finalized-lean-proof');
      assert.equal(
        binding.manuscriptClaimHash,
        manuscriptClaimHash({
          claimId: claim.claimId,
          text: claim.statement,
          sourceLocator,
        }),
      );
      assert.notEqual(binding.manuscriptClaimHash, claim.manuscriptSource.contentHash);
      const receipt = agentReceipt({
        agentId: `formal-reviewer-${reviewerCalls}`,
        role: input.role,
        structuredOutput: {
          version: 1,
          kind: 'FormalClaimSemanticReview',
          theoremSpecificationHash: specification.theoremSpecificationHash,
          reviews: [{
            claimId: claim.claimId, theoremName: binding.theoremName,
            manuscriptClaimHash: binding.manuscriptClaimHash,
            theoremTypeHash: binding.expectedTypeHash, sourceStatementHash: binding.sourceStatementHash,
            status: 'formal_semantic_review_verified', semanticEquivalenceVerified: true, verdict: 'equivalent',
          }],
        },
        changedPaths: [],
      });
      reviewerReceiptHashes.push(receipt.agentExecutionReceiptHash);
      return receipt;
    },
  };
  const researchVerifier = Object.freeze({
    version: 1,
    kind: 'CampaignResearchVerifierPort',
    async verify(input) {
      verifierInputs.push(input);
      const completed = completeAfterIteration !== null
        && input.formalVerificationIteration >= completeAfterIteration;
      const payload = {
        version: 1,
        kind: 'CampaignFormalVerificationReceipt',
        status: completed ? 'campaign_formal_verification_completed' : 'campaign_formal_verification_blocked',
        nativeResearchWorkerExecutionReportHash: hashRecord('FormalCandidateWorkerReportFixture', {
          iteration: input.formalVerificationIteration,
        }),
        formalVerificationIteration: input.formalVerificationIteration,
        formalRepairHistory: input.formalRepairHistory,
        typedTheoremObligationBundleHash:
          input.typedTheoremObligationBundle.typedTheoremObligationBundleHash,
        formalProofSearchPlanHash: input.formalProofSearchPlan.formalProofSearchPlanHash,
        formalProofSearchCandidateId: input.formalProofSearchCandidate.candidateId,
        formalProofSearchOperationReceiptHash:
          input.formalProofSearchOperationReceipt.formalProofSearchOperationReceiptHash,
        formalProofSearchOperationReceipt: input.formalProofSearchOperationReceipt,
        formalProofSearchAttempts: input.formalProofSearchAttempts,
        nativeResearchWorkerExecution: {
          workerReceipts: [{
            workerId: 'system-finalized-lean-proof',
            status: completed
              ? 'native_research_worker_execution_verified'
              : 'native_research_worker_execution_blocked',
            blockers: completed ? [] : ['fixture_axiom_audit_blocked'],
            result: {
              status: completed ? 'formal_claim_verified' : 'formal_claim_binding_blocked',
              blockers: completed ? [] : ['fixture_axiom_audit_blocked'],
              claimBindingReport: {
                bindings: [{
                  claimId: input.theoremSpecification.claims[0].claimId,
                  theoremName: 'reflexiveIdentity',
                  axioms: completed ? [] : ['propext'],
                  issues: completed ? [] : ['target_theorem_uses_unapproved_axioms'],
                }],
              },
            },
          }],
        },
        blockers: completed ? [] : [`fixture_lake_failure:${input.formalVerificationIteration}`],
      };
      return Object.freeze({
        ...payload,
        campaignFormalVerificationReceiptHash: hashRecord('CampaignFormalVerificationReceipt', payload),
      });
    },
  });
  const executor = createCampaignNodeExecutor({
    runtimeRoot,
    agentExecutor,
    formalReviewAgentExecutor,
    researchVerifier,
    empiricalExecutor: { execute() { throw new Error('unexpected_empirical_execution'); } },
  });
  const campaign = Object.freeze({
    campaignId: 'campaign', paperId: 'paper',
    spec: Object.freeze({
      sourceWorkspace: workspace,
      paperQualityProfile: 'formal_theorem_or_proof',
      researchVerificationInput: Object.freeze({
        paperTask: Object.freeze({ taskKey: 'paper_factory:paper' }),
      }),
    }),
  });
  const node = Object.freeze({
    nodeId: 'campaign:0:formal-verify', kind: 'formal-verify', roundIndex: 0,
    dependencies: ['campaign:0:theorem-spec'], attemptId: 'attempt-1', leaseGeneration: 1,
  });
  return {
    workspace, executor, campaign, node, verifierInputs, reviewerReceiptHashes, authorInputs,
    counts: () => ({ authorCalls, reviewerCalls }),
  };
}

test('a failed bounded formal candidate never pollutes the source workspace', async (t) => {
  const value = fixture(t, { completeAfterIteration: null });
  await assert.rejects(
    () => value.executor.execute({
      campaign: value.campaign, node: value.node, allNodes: [],
      deferWorkspaceIntegration: true,
      executionBudget: { remainingTokenCount: 100_000, remainingWallTimeMs: 60_000 },
    }),
    (error) => {
      assert.match(error.message, /campaign_formal_verification_blocked:fixture_lake_failure:2/);
      assert.equal(error.receipt.kind, 'FormalProofSearchFailureCertificate');
      assert.equal(error.receipt.status, 'formal_proof_search_exhausted');
      assert.equal(error.receipt.attempts.length, 3);
      assert.equal(error.receipt.kernelProofStatus, 'not_established');
      assert.equal(error.receipt.counterexampleStatus, 'not_established');
      assert.match(error.receipt.formalProofSearchFailureCertificateHash, /^sha256:/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(value.workspace, 'Main.lean'), 'utf8'), 'before\n');
  assert.deepEqual(value.verifierInputs.map((input) => input.formalVerificationIteration), [0, 1, 2]);
  assert.deepEqual(value.verifierInputs.map((input) => input.formalProofSearchCandidate.strategy), [
    'direct_elaboration', 'mathlib_retrieval', 'bounded_refutation_or_synthesis',
  ]);
  assert.deepEqual(value.verifierInputs.map((input) => input.formalProofSearchAttempts.length), [0, 1, 2]);
  assert.equal(new Set(value.reviewerReceiptHashes).size, 3);
  assert.deepEqual(value.counts(), { authorCalls: 3, reviewerCalls: 3 });
});

test('repair gets a new independent review and iteration-scoped verification before atomic integration', async (t) => {
  const value = fixture(t, { completeAfterIteration: 1 });
  const result = await value.executor.execute({
    campaign: value.campaign, node: value.node, allNodes: [],
    deferWorkspaceIntegration: true,
    executionBudget: { remainingTokenCount: 100_000, remainingWallTimeMs: 60_000 },
  });
  assert.equal(result.status, 'campaign_formal_verification_completed');
  assert.equal(fs.readFileSync(path.join(value.workspace, 'Main.lean'), 'utf8'), 'before\n');
  assert.deepEqual(value.verifierInputs.map((input) => input.formalVerificationIteration), [0, 1]);
  assert.deepEqual(value.verifierInputs.map((input) => input.formalProofSearchCandidate.strategy), [
    'direct_elaboration', 'mathlib_retrieval',
  ]);
  assert.equal(new Set(value.reviewerReceiptHashes).size, 2);
  assert.notEqual(
    value.verifierInputs[0].formalReviewEnvelope.formalSemanticReviewEnvelopeHash,
    value.verifierInputs[1].formalReviewEnvelope.formalSemanticReviewEnvelopeHash,
  );
  assert.match(value.authorInputs[1].instructions, /"axioms":\["propext"\]/);
  assert.match(value.authorInputs[1].instructions, /SYSTEM_ALLOWED_FORMAL_AXIOMS=\[\]/);
  assert.match(value.authorInputs[1].instructions, /expand 'Nat\.min_def'/);
  assert.match(value.authorInputs[1].instructions, /'Nat\.le_refl'/);
  assert.match(
    value.authorInputs[1].instructions,
    /change \(if loss ≤ cap then loss else cap\) ≤ cap/,
  );
  assert.match(
    value.authorInputs[1].instructions,
    /use this already kernel-audited declaration verbatim/,
  );
  assert.match(
    value.authorInputs[1].instructions,
    /Do not replace its change step with rw, simp, omega/,
  );
  assert.match(
    value.authorInputs[1].instructions,
    /host system-finalizes RESEARCH_WORKER_PLAN\.json/,
  );
  assert.match(
    value.authorInputs[1].instructions,
    /do not edit or calculate those identities/,
  );
  assert.equal(value.verifierInputs[1].formalRepairHistory.length, 1);
  const integration = value.executor.integratePrepared({
    campaign: value.campaign, node: value.node, result,
  });
  assert.equal(integration.status, 'workspace_attempt_integrated');
  assert.match(fs.readFileSync(path.join(value.workspace, 'Main.lean'), 'utf8'), /-- repair 2/);
  assert.deepEqual(value.counts(), { authorCalls: 2, reviewerCalls: 2 });
});

test('approved formal proposal writer retries invalid theorem output without source pollution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-proposal-writer-'));
  const workspace = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skeleton = '\\documentclass{article}\n\\begin{document}\nTODO\n\\end{document}\n';
  const completed = [
    '\\documentclass{article}',
    '\\newtheorem{theorem}{Theorem}',
    '\\begin{document}',
    '\\begin{theorem}For every natural number n, under the assumption that n is natural, n equals n.\\end{theorem}',
    '\\begin{proof}By reflexivity.\\end{proof}',
    '\\section{Limitations}This result states only reflexive equality and makes no claim about distinct values.',
    '\\end{document}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(workspace, 'main.tex'), skeleton);
  const proposalEnvelopeHash = hashRecord('ProposalEnvelopeFixture', { paperId: 'paper-writer' });
  const productionPlanEnvelopeHash = hashRecord('ProductionPlanEnvelopeFixture', { paperId: 'paper-writer' });
  const reviewGateHash = hashRecord('ProposalReviewGateFixture', { paperId: 'paper-writer' });
  const scientificClaimInputHash = hashRecord('PaperScientificClaimInputFixture', { paperId: 'paper-writer' });
  const bundlePayload = {
    version: 1,
    kind: 'PaperProposalSeedContractBundle',
    paperId: 'paper-writer',
    taskKey: 'paper_factory:paper-writer',
    status: 'proposal_seed_contracts_ready',
    proposalEnvelopeHash,
    productionPlanEnvelopeHash,
    reviewGateHash,
    scientificClaimInputHash,
    claims: [{
      id: 'claim-1', kind: 'proposal_claim_seed', text: 'Reflexive equality.', status: 'proposal_seed',
      scientificClaimInputHash, scientificClaimKey: 'reflexive-equality',
      assumptions: ['The term is well-typed.'], quantifiers: ['For every well-typed term.'],
      negativeBoundaries: ['No claim about unequal terms is made.'],
      proofObligations: ['Prove reflexivity.'],
    }],
    proof_obligations: [{ id: 'proof-1', text: 'Prove reflexivity.' }],
    evidence: [],
    reproducibility: [],
    blockers: [],
    warnings: [],
  };
  const proposalSeedContractBundleHash = hashPaperRecord('PaperProposalSeedContractBundle', bundlePayload);
  fs.writeFileSync(path.join(workspace, 'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json'), `${JSON.stringify({
    ...bundlePayload,
    paperProposalSeedContractBundleHash: proposalSeedContractBundleHash,
  }, null, 2)}\n`);
  const bindingPayload = {
    version: 1,
    kind: 'ApprovedProposalSeedBinding',
    status: 'approved_proposal_seed_bound',
    contractPath: 'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json',
    proposalEnvelopeHash,
    productionPlanEnvelopeHash,
    reviewGateHash,
    proposalSeedContractBundleHash,
  };
  const campaign = Object.freeze({
    campaignId: 'campaign-writer',
    paperId: 'paper-writer',
    spec: Object.freeze({
      sourceWorkspace: workspace,
      paperQualityProfile: 'formal_theorem_or_proof',
      approvedProposalSeed: Object.freeze({
        ...bindingPayload,
        approvedProposalSeedBindingHash: hashRecord('ApprovedProposalSeedBinding', bindingPayload),
      }),
    }),
  });
  let calls = 0;
  const executor = createCampaignNodeExecutor({
    runtimeRoot,
    agentExecutor: {
      async execute(input) {
        calls += 1;
        assert.equal(input.role, 'writer');
        assert.match(input.context.approvedProposalSeedVerificationReceiptHash, /^sha256:/);
        fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), calls === 1
          ? '\\documentclass{article}\n\\begin{document}\nNo theorem.\\end{document}\n'
          : completed);
        return agentReceipt({ agentId: `writer-${calls}`, role: input.role, changedPaths: ['main.tex'] });
      },
    },
    empiricalExecutor: { execute() { throw new Error('unexpected_empirical_execution'); } },
  });
  const firstNode = Object.freeze({
    nodeId: 'campaign-writer:0:writer', kind: 'writer', role: 'writer', roundIndex: 0,
    dependencies: [], attemptId: 'writer-attempt-1', leaseGeneration: 1,
  });
  await assert.rejects(
    () => executor.execute({
      campaign, node: firstNode, allNodes: [], deferWorkspaceIntegration: true,
      executionBudget: { remainingTokenCount: 20_000, remainingWallTimeMs: 60_000 },
    }),
    (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /formal_proposal_writer_surface_blocked:.*theorem_statement_missing/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8'), skeleton);

  const secondNode = Object.freeze({ ...firstNode, attemptId: 'writer-attempt-2', leaseGeneration: 2 });
  const result = await executor.execute({
    campaign, node: secondNode, allNodes: [], deferWorkspaceIntegration: true,
    executionBudget: { remainingTokenCount: 20_000, remainingWallTimeMs: 60_000 },
  });
  assert.equal(fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8'), skeleton);
  assert.equal(result.status, 'agent_execution_completed');
  const integration = executor.integratePrepared({ campaign, node: secondNode, result });
  assert.equal(integration.status, 'workspace_attempt_integrated');
  assert.equal(fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8'), completed);
  assert.equal(calls, 2);

  const seedPath = path.join(workspace, bindingPayload.contractPath);
  const tamperedSeed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  tamperedSeed.claims[0].text = 'A stronger unapproved claim.';
  fs.writeFileSync(seedPath, `${JSON.stringify(tamperedSeed, null, 2)}\n`);
  const tamperedNode = Object.freeze({ ...firstNode, attemptId: 'writer-attempt-3', leaseGeneration: 3 });
  await assert.rejects(
    () => executor.execute({
      campaign, node: tamperedNode, allNodes: [], deferWorkspaceIntegration: true,
      executionBudget: { remainingTokenCount: 20_000, remainingWallTimeMs: 60_000 },
    }),
    (error) => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /approved_formal_proposal_seed_invalid:.*approved_proposal_seed_contract_hash_invalid/);
      return true;
    },
  );
  assert.equal(calls, 2);
});
