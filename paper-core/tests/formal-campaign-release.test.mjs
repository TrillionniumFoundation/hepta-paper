import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { buildCampaignResearchVerificationInput } from '../../paper-domain/automation/campaign-research-contract.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { createPaperTask } from '../../paper-domain/contracts/workflow-contracts.mjs';
import { verifyCampaignReleaseBundle } from '../../paper-domain/automation/campaign-release-contracts.mjs';
import { manuscriptClaimHash } from '../../paper-domain/research/formal-claim-contract.mjs';
import { leanSourceDeclarationRecords } from '../../paper-adapters/research-verify/lean-source-contracts.mjs';
import { createPinnedFormalSandboxRuntime } from '../../paper-adapters/research-verify/lake-formal-worker.mjs';
import { bootstrapAutomationContext } from '../../paper-composition/bootstrap/automation-context-bootstrap.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createReadOnlyAutonomousSubmissionHandoffOutboxFixture,
} from './support/autonomous-submission-handoff-fixture.mjs';

const FORMAL_SANDBOX_IMAGE_DIGEST = 'sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';
const FORMAL_SANDBOX_RUNTIME = createPinnedFormalSandboxRuntime({
  image: `alpine@${FORMAL_SANDBOX_IMAGE_DIGEST}`,
  imageDigest: FORMAL_SANDBOX_IMAGE_DIGEST,
});

function stableAgentReceipt({ agentId, role, structuredOutput = null, changedPaths = [] } = {}) {
  const payload = {
    status: 'agent_execution_completed',
    providerMode: 'openclaw:detached-child-session',
    executorId: 'openclaw-agent-executor-v1',
    agentId,
    agentCapabilityProfileHash: hashRecord('AgentCapabilityProfileFixture', { agentId }),
    openClawAgentConfigurationHash: hashRecord('OpenClawAgentConfigurationFixture', { agentId }),
    openClawGatewayConfigurationHash: hashRecord('OpenClawGatewayConfigurationFixture', { gateway: 'fixture' }),
    resolvedModel: 'formal-review-model',
    role,
    changedPaths,
    structuredOutput,
    finalOutput: structuredOutput ? JSON.stringify(structuredOutput) : '',
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
}

test('approved proposal seed closes through writer theorem, system spec, Lean replay, aggregate verification, and release', async (t) => {
  assert.throws(() => createPinnedFormalSandboxRuntime({
    image: 'alpine:3.20',
    imageDigest: FORMAL_SANDBOX_IMAGE_DIGEST,
  }), /formal_sandbox_runtime_image_reference_not_digest_pinned/);
  assert.equal(FORMAL_SANDBOX_RUNTIME.imageDigest, FORMAL_SANDBOX_IMAGE_DIGEST);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-campaign-release-'));
  const workspace = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(workspace, 'automation-results', 'final'), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const claimText = 'For every natural number $n$, under the assumption that $n$ is a natural number, $n=n$.';
  const manuscript = [
    '\\documentclass{article}',
    '\\usepackage{amsthm}',
    '\\newtheorem{theorem}{Theorem}',
    '\\begin{document}',
    `\\begin{theorem}${claimText}\\end{theorem}`,
    '\\begin{proof}By reflexivity.\\end{proof}',
    '\\section{Limitations}This theorem states only reflexive equality.',
    '\\appendix',
    '\\section{Formal source}The checked Lean source is included in the package.',
    '\\end{document}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(workspace, 'main.tex'), [
    '\\documentclass{article}',
    '\\usepackage{amsthm}',
    '\\newtheorem{theorem}{Theorem}',
    '\\begin{document}',
    '\\section{Main Result}',
    '% TODO: materialize this section from the approved production plan.',
    '\\end{document}',
    '',
  ].join('\n'));
  const proposalSeedPath = 'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json';
  const formalCertificateRequestPath = 'FORMAL_CERTIFICATE_REQUEST.json';
  const proposalEnvelopeHash = hashRecord('ProposalEnvelopeFixture', {});
  const productionPlanEnvelopeHash = hashRecord('ProductionPlanEnvelopeFixture', {});
  const reviewGateHash = hashRecord('ProposalReviewGateFixture', {});
  const scientificClaimInputHash = hashRecord('PaperScientificClaimInputFixture', { claimText });
  const proposalSeedPayload = {
    version: 1,
    kind: 'PaperProposalSeedContractBundle',
    paperId: 'paper-formal',
    taskKey: 'paper_factory:paper-formal',
    status: 'proposal_seed_contracts_ready',
    proposalEnvelopeHash,
    productionPlanEnvelopeHash,
    reviewGateHash,
    scientificClaimInputHash,
    claims: [{
      id: 'proposal-claim-1', kind: 'proposal_claim_seed', text: claimText, status: 'proposal_seed',
      scientificClaimInputHash, scientificClaimKey: 'reflexive-identity',
      assumptions: ['n is a natural number.'], quantifiers: ['For every natural number n.'],
      negativeBoundaries: ['No claim about distinct values is made.'],
      proofObligations: ['Prove reflexive identity.'],
    }],
    proof_obligations: [{ id: 'proposal-proof-1', kind: 'proposal_proof_obligation_seed', text: 'Prove reflexive identity.', status: 'proposal_seed' }],
    evidence: [{ id: 'proposal-evidence-1', kind: 'proposal_evidence_plan_seed', text: 'Lean verification.', status: 'proposal_seed' }],
    reproducibility: [], blockers: [], warnings: [],
  };
  const proposalSeedContractBundleHash = hashPaperRecord('PaperProposalSeedContractBundle', proposalSeedPayload);
  fs.writeFileSync(path.join(workspace, proposalSeedPath), `${JSON.stringify({
    ...proposalSeedPayload,
    paperProposalSeedContractBundleHash: proposalSeedContractBundleHash,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workspace, 'proof_status.md'), '# Proof Status\n\nAll proof obligations are closed by the checked Lean project.\n');
  fs.writeFileSync(path.join(workspace, 'evidence_manifest.md'), '# Evidence Manifest\n\nThe bundled Lean replay receipt verifies the formal claim.\n');
  fs.writeFileSync(path.join(workspace, 'appendix.tex'), 'Formal source appendix.\n');
  const leanSource = 'theorem reflexiveIdentity (n : Nat) : n = n := by rfl\n';

  const packageFiles = [
    'main.tex', 'proof_status.md', 'evidence_manifest.md', 'appendix.tex', 'lakefile.lean',
    'lean-toolchain', 'lake-manifest.json', 'Main.lean', 'RESEARCH_WORKER_PLAN.json',
    'THEOREM_SPEC.json', formalCertificateRequestPath, proposalSeedPath,
  ];
  fs.writeFileSync(path.join(workspace, 'SOURCE_PACKAGE_CONTRACT.json'), `${JSON.stringify({
    version: 1,
    kind: 'SourcePackageContract',
    paperId: 'paper-formal',
    venueTarget: 'Formal Journal',
    files: packageFiles.map((file) => ({ path: file, role: file === 'main.tex' ? 'main_tex' : 'source_file', required: true })),
  }, null, 2)}\n`);

  const store = createDefaultPaperStore({ root: workspace, runtimeRoot, targetVersion: 25 });
  const context = bootstrapAutomationContext({
    root: workspace,
    runtimeRoot,
    mode: 'formal-campaign-release-test',
    execute: true,
    serviceOverrides: {
      store,
      trustedFormalSandboxRuntime: FORMAL_SANDBOX_RUNTIME,
      autonomousSubmissionOutbox:
        createReadOnlyAutonomousSubmissionHandoffOutboxFixture(),
    },
  });
  t.after(() => context.services.persistenceSession.close());
  const paperTask = createPaperTask({
    paperId: 'paper-formal',
    title: 'Formal campaign fixture',
    venueTarget: 'Formal Journal',
    sourceWorkspace: workspace,
    mainTex: path.join(workspace, 'main.tex'),
    registry: {
      inventorySource: 'proposal_materialization',
      proposalEnvelopeHash,
      productionPlanEnvelopeHash,
      reviewGateHash,
      proposalSeedContractBundleHash,
    },
    source: {
      exists: true,
      sourceSkeleton: true,
      proposalSeedContracts: proposalSeedPath,
    },
    paperQualityProfile: 'formal_theorem_or_proof',
    createdAt: '2026-07-14T00:00:00.000Z',
  });
  const campaign = Object.freeze({
    campaignId: 'campaign-formal',
    paperId: paperTask.paperId,
    spec: Object.freeze({
      campaignPlanHash: hashRecord('FormalCampaignPlanFixture', {}),
      sourceWorkspace: workspace,
      venueTarget: paperTask.venueTarget,
      title: paperTask.title,
      paperQualityProfile: 'formal_theorem_or_proof',
      approvedProposalSeed: (() => {
        const payload = {
          version: 1,
          kind: 'ApprovedProposalSeedBinding',
          status: 'approved_proposal_seed_bound',
          contractPath: proposalSeedPath,
          proposalEnvelopeHash,
          productionPlanEnvelopeHash,
          reviewGateHash,
          proposalSeedContractBundleHash,
        };
        return Object.freeze({
          ...payload,
          approvedProposalSeedBindingHash: hashRecord('ApprovedProposalSeedBinding', payload),
        });
      })(),
      researchVerificationInput: buildCampaignResearchVerificationInput({ paperId: paperTask.paperId, paperTask, paperState: { evidenceRefs: [] } }),
    }),
  });
  let authorCallCount = 0;
  let writerCallCount = 0;
  const agentExecutor = {
    async execute(input) {
      if (input.role === 'writer') {
        writerCallCount += 1;
        assert.match(input.instructions, /approved formal proposal source/i);
        assert.equal(input.context.formalProposalSeedRequired, true);
        assert.match(input.context.approvedProposalSeedVerificationReceiptHash, /^sha256:/);
        const seed = JSON.parse(fs.readFileSync(path.join(input.workspacePath, proposalSeedPath), 'utf8'));
        assert.equal(seed.status, 'proposal_seed_contracts_ready');
        assert.equal(seed.claims[0].text, claimText);
        fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), manuscript);
        return stableAgentReceipt({ agentId: 'proposal-theorem-writer', role: input.role, changedPaths: ['main.tex'] });
      }
      if (input.role === 'theorem-spec-author') {
        fs.writeFileSync(path.join(input.workspacePath, 'THEOREM_SPEC_DRAFT.json'), `${JSON.stringify({
          version: 1,
          kind: 'TheoremSpecificationDraft',
          claims: [{
            claimKey: 'reflexive-identity',
            title: 'Reflexive identity',
            statement: claimText,
            assumptions: ['n is a natural number.'],
            quantifiers: ['For every natural number n.'],
            negativeBoundaries: ['No claim about distinct values is made.'],
            proofObligations: ['Prove reflexive identity.'],
            evidenceObligations: [],
            manuscriptIntent: 'existing',
            proposalClaimId: 'proposal-claim-1',
          }],
        }, null, 2)}\n`);
        return stableAgentReceipt({
          agentId: 'theorem-spec-author', role: input.role,
          changedPaths: ['THEOREM_SPEC_DRAFT.json'],
        });
      }
      if (input.role !== 'formal-author') throw new Error(`unexpected_primary_agent_execution:${input.role}`);
      authorCallCount += 1;
      const specification = JSON.parse(fs.readFileSync(path.join(input.workspacePath, 'THEOREM_SPEC.json'), 'utf8'));
      assert.equal(input.context.theoremSpecificationHash, specification.theoremSpecificationHash);
      const claim = specification.claims[0];
      const declaration = leanSourceDeclarationRecords(leanSource).find((item) => item.name === 'reflexiveIdentity');
      assert.ok(declaration);
      fs.writeFileSync(path.join(input.workspacePath, 'lakefile.lean'), [
        'import Lake', 'open Lake DSL', 'package heptaFormalCampaign where',
        '@[default_target]', 'lean_lib Main where', '',
      ].join('\n'));
      fs.writeFileSync(path.join(input.workspacePath, 'lean-toolchain'), 'leanprover/lean4:v4.30.0\n');
      fs.writeFileSync(path.join(input.workspacePath, 'lake-manifest.json'), `${JSON.stringify({
        version: '1.1.0', packagesDir: '.lake/packages', packages: [], name: 'heptaFormalCampaign', lakeDir: '.lake',
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(input.workspacePath, 'Main.lean'), leanSource);
      const plan = {
        version: 1,
        kind: 'NativeResearchWorkerPlan',
        paperId: paperTask.paperId,
        taskKey: paperTask.taskKey,
        workers: [{
          id: 'lean-proof', type: 'formal_verifier_lake', evidenceClass: 'research_evidence',
          syntheticInput: false, outcomesPreprogrammed: false, claimIds: [claim.claimId],
          inputs: [{ role: 'formal_source', path: 'Main.lean', sha256: hashBytes(Buffer.from(leanSource)) }],
          parameters: {
            projectRoot: '.', executable: 'lake',
            claimBindings: [{
              claimId: claim.claimId,
              theoremSpecificationHash: specification.theoremSpecificationHash,
              theoremSpecificationClaimHash: claim.theoremSpecificationClaimHash,
              theoremName: 'reflexiveIdentity', sourceFile: 'Main.lean',
              expectedTypeHash: declaration.typeHash, sourceStatementHash: declaration.statementHash,
              proofObligations: claim.proofObligations,
              proofObligationContracts: claim.proofObligationContracts,
              proofObligationMappings: claim.proofObligationContracts.map((obligation) => ({
                ...obligation,
                leanDeclarations: ['reflexiveIdentity'],
              })),
              manuscriptSource: {
                path: claim.manuscriptSource.path,
                byteStart: claim.manuscriptSource.byteStart,
                byteEnd: claim.manuscriptSource.byteEnd,
                contentHash: claim.manuscriptSource.contentHash,
              },
            }],
          },
        }],
      };
      fs.writeFileSync(path.join(input.workspacePath, 'RESEARCH_WORKER_PLAN.json'), `${JSON.stringify(plan, null, 2)}\n`);
      fs.writeFileSync(path.join(input.workspacePath, formalCertificateRequestPath), `${JSON.stringify({
        version: 1,
        kind: 'FormalCertificateRequestFixture',
        formalCertificateRequest: {
          verifierKind: 'lean',
          sourceRecords: [{ path: 'Main.lean' }],
          claimBindings: claim.proofObligationContracts.map((obligation) => ({
            claimId: claim.claimId,
            obligationId: obligation.obligationId,
            statementHash: hashBytes(Buffer.from(claim.statement, 'utf8')),
          })),
        },
      }, null, 2)}\n`);
      return stableAgentReceipt({
        agentId: 'formal-author', role: input.role,
        changedPaths: [
          'Main.lean',
          formalCertificateRequestPath,
          'RESEARCH_WORKER_PLAN.json',
          'lake-manifest.json',
          'lakefile.lean',
          'lean-toolchain',
        ],
      });
    },
  };
  let reviewCallCount = 0;
  const formalReviewAgentExecutor = {
    async execute(input) {
      reviewCallCount += 1;
      const specification = JSON.parse(fs.readFileSync(path.join(input.workspacePath, 'THEOREM_SPEC.json'), 'utf8'));
      const plan = JSON.parse(fs.readFileSync(path.join(input.workspacePath, 'RESEARCH_WORKER_PLAN.json'), 'utf8'));
      const binding = plan.workers[0].parameters.claimBindings[0];
      const claim = specification.claims[0];
      const sourceLocator = `${claim.manuscriptSource.path}#bytes=${claim.manuscriptSource.byteStart}-${claim.manuscriptSource.byteEnd}`;
      return stableAgentReceipt({
        agentId: `formal-reviewer-${reviewCallCount}`,
        role: input.role,
        structuredOutput: {
          version: 2,
          kind: 'FormalClaimSemanticReview',
          theoremSpecificationHash: specification.theoremSpecificationHash,
          reviews: [{
            claimId: claim.claimId,
            theoremName: binding.theoremName,
            manuscriptClaimHash: manuscriptClaimHash({ claimId: claim.claimId, text: claim.statement, sourceLocator }),
            theoremTypeHash: binding.expectedTypeHash,
            sourceStatementHash: binding.sourceStatementHash,
            status: 'formal_semantic_review_verified',
            semanticEquivalenceVerified: true,
            verdict: 'equivalent',
            proposalClaimId: claim.proposalClaimSource.proposalClaimId,
            proposalClaimRecordHash: claim.proposalClaimSource.proposalClaimRecordHash,
            proposalClaimTextHash: claim.proposalClaimSource.proposalClaimTextHash,
            proposalToTheoremSemanticVerified: true,
            proposalToTheoremVerdict: 'equivalent',
            approvedNarrowingRationale: null,
          }],
        },
        changedPaths: [],
      });
    },
  };
  const executor = createCampaignNodeExecutor({
    runtimeRoot,
    researchVerifier: context.services.researchVerifier,
    releasePackager: context.services.releasePackager,
    agentExecutor,
    formalReviewAgentExecutor,
    empiricalExecutor: { execute() { throw new Error('unexpected_empirical_execution'); } },
  });
  const campaignStore = context.services.campaignStore;
  campaignStore.createCampaign({
    ...campaign.spec,
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    maxRounds: 1,
    nodes: [
      { nodeId: 'campaign-formal:writer', kind: 'writer', roundIndex: 0, dependencies: [], priority: 1, maxAttempts: 1, role: 'writer' },
      { nodeId: 'campaign-formal:theorem-spec', kind: 'theorem-spec', roundIndex: 0, dependencies: ['campaign-formal:writer'], priority: 2, maxAttempts: 1, role: 'theorem-spec-author' },
      { nodeId: 'campaign-formal:formal-verify', kind: 'formal-verify', roundIndex: 0, dependencies: ['campaign-formal:theorem-spec'], priority: 3, maxAttempts: 1 },
      { nodeId: 'campaign-formal:final-compile', kind: 'final-compile', roundIndex: 0, dependencies: ['campaign-formal:formal-verify'], priority: 4, maxAttempts: 1 },
      { nodeId: 'campaign-formal:research-verify', kind: 'research-verify', roundIndex: 0, dependencies: ['campaign-formal:final-compile', 'campaign-formal:formal-verify'], priority: 5, maxAttempts: 1 },
    ],
  });
  const writerClaim = campaignStore.claimReady({ campaignId: campaign.campaignId, workerId: 'formal-worker', leaseSeconds: 600, limit: 1 })[0];
  const runningWriterNode = campaignStore.startNode({ nodeId: writerClaim.nodeId, workerId: 'formal-worker', attemptId: writerClaim.attemptId, leaseGeneration: writerClaim.leaseGeneration });
  const writerResult = await executor.execute({ campaign, node: runningWriterNode, allNodes: [runningWriterNode] });
  campaignStore.completeNode({ nodeId: runningWriterNode.nodeId, workerId: 'formal-worker', attemptId: runningWriterNode.attemptId, leaseGeneration: runningWriterNode.leaseGeneration, result: writerResult });
  assert.equal(writerCallCount, 1);
  assert.match(fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8'), /\\begin\{theorem\}/);
  assert.match(fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8'), /\\end\{theorem\}\n\\begin\{proof\}/);
  const specificationClaim = campaignStore.claimReady({ campaignId: campaign.campaignId, workerId: 'formal-worker', leaseSeconds: 600, limit: 1 })[0];
  const runningSpecificationNode = campaignStore.startNode({ nodeId: specificationClaim.nodeId, workerId: 'formal-worker', attemptId: specificationClaim.attemptId, leaseGeneration: specificationClaim.leaseGeneration });
  const specificationResult = await executor.execute({ campaign, node: runningSpecificationNode, allNodes: [runningSpecificationNode] });
  assert.equal(specificationResult.status, 'campaign_theorem_specification_completed');
  const completedSpecificationNode = campaignStore.completeNode({ nodeId: runningSpecificationNode.nodeId, workerId: 'formal-worker', attemptId: runningSpecificationNode.attemptId, leaseGeneration: runningSpecificationNode.leaseGeneration, result: specificationResult });
  const verifyClaim = campaignStore.claimReady({ campaignId: campaign.campaignId, workerId: 'formal-worker', leaseSeconds: 600, limit: 1 })[0];
  const formalVerifyNode = campaignStore.startNode({ nodeId: verifyClaim.nodeId, workerId: 'formal-worker', attemptId: verifyClaim.attemptId, leaseGeneration: verifyClaim.leaseGeneration });
  let formalResult;
  try {
    formalResult = await executor.execute({
      campaign,
      node: formalVerifyNode,
      allNodes: [completedSpecificationNode, formalVerifyNode],
    });
  } catch (error) {
    assert.fail(`${error.message}\n${JSON.stringify(error.receipt, null, 2)}`);
  }
  assert.equal(authorCallCount, 1);
  assert.equal(reviewCallCount, 1);
  assert.equal(formalResult.kind, 'CampaignFormalVerificationReceipt');
  assert.equal(formalResult.status, 'campaign_formal_verification_completed', JSON.stringify(formalResult.blockers));
  const canonicalSpecification = JSON.parse(fs.readFileSync(path.join(workspace, 'THEOREM_SPEC.json'), 'utf8'));
  assert.equal(formalResult.theoremSpecificationHash, canonicalSpecification.theoremSpecificationHash);
  assert.deepEqual(formalResult.theoremSpecificationClaimHashes, canonicalSpecification.claims.map((claim) => claim.theoremSpecificationClaimHash));
  assert.equal(formalResult.formalReviewEnvelope.theoremSpecificationHash, canonicalSpecification.theoremSpecificationHash);
  assert.equal(formalResult.proposalClaimToTheoremBindingHash,
    formalResult.formalReviewEnvelope.proposalClaimToTheoremBindingHash);
  assert.equal(formalResult.proposalClaimToTheoremBinding.entries[0].proposalClaimId, 'proposal-claim-1');
  assert.equal(formalResult.nativeResearchWorkerExecution.theoremSpecificationHash, canonicalSpecification.theoremSpecificationHash);
  const formalReceipt = formalResult.nativeResearchWorkerExecution.workerReceipts[0];
  assert.equal(formalReceipt.result.status, 'formal_claim_verified');
  assert.equal(formalReceipt.result.replayReceipt.status, 'formal_claim_replay_verified');
  assert.ok(formalResult.formalReplayReceiptHashes.includes(formalReceipt.result.formalCertificateReplayReceiptHash));
  assert.equal(formalResult.campaignFormalSourceSnapshotHash, formalResult.campaignFormalSourceSnapshot.campaignResearchSourceSnapshotHash);
  assert.equal(formalResult.verifiedSourceMerkleHash, formalResult.campaignFormalSourceSnapshot.verifiedSourceMerkleHash);
  assert.equal(formalResult.verifiedSourceWorkspaceManifestHash, formalResult.campaignFormalSourceSnapshot.verifiedSourceWorkspaceManifestHash);
  campaignStore.completeNode({ nodeId: formalVerifyNode.nodeId, workerId: 'formal-worker', attemptId: formalVerifyNode.attemptId, leaseGeneration: formalVerifyNode.leaseGeneration, result: formalResult });

  const finalCompileClaim = campaignStore.claimReady({ campaignId: campaign.campaignId, workerId: 'formal-worker', leaseSeconds: 600, limit: 1 })[0];
  const runningFinalCompileNode = campaignStore.startNode({
    nodeId: finalCompileClaim.nodeId,
    workerId: 'formal-worker',
    attemptId: finalCompileClaim.attemptId,
    leaseGeneration: finalCompileClaim.leaseGeneration,
  });
  const completedFinalCompileNode = campaignStore.completeNode({
    nodeId: runningFinalCompileNode.nodeId,
    workerId: 'formal-worker',
    attemptId: runningFinalCompileNode.attemptId,
    leaseGeneration: runningFinalCompileNode.leaseGeneration,
    result: { status: 'empirical_execution_completed', materializedPaths: ['automation-results/final/main.pdf'] },
  });

  const researchClaim = campaignStore.claimReady({ campaignId: campaign.campaignId, workerId: 'formal-worker', leaseSeconds: 600, limit: 1 })[0];
  const runningResearchNode = campaignStore.startNode({
    nodeId: researchClaim.nodeId,
    workerId: 'formal-worker',
    attemptId: researchClaim.attemptId,
    leaseGeneration: researchClaim.leaseGeneration,
  });
  const tamperedFormalResult = {
    ...formalResult,
    verifiedSourceMerkleHash: `sha256:${'f'.repeat(64)}`,
  };
  await assert.rejects(
    () => executor.execute({
      campaign,
      node: runningResearchNode,
      allNodes: [
        completedSpecificationNode,
        { ...formalVerifyNode, status: 'completed', result: tamperedFormalResult },
        runningResearchNode,
      ],
    }),
    /campaign_research_formal_verification_context_invalid/,
  );
  let researchResult;
  try {
    researchResult = await executor.execute({
      campaign,
      node: runningResearchNode,
      allNodes: [completedSpecificationNode, { ...formalVerifyNode, status: 'completed', result: formalResult }, runningResearchNode],
    });
  } catch (error) {
    assert.fail(`${error.message}\n${JSON.stringify({
      promotionBlockers: error.receipt?.researchPromotionBlockers,
      trustedFormalEvidence:
        error.receipt?.report?.capabilities?.trustedFormalEvidence,
      formalCertificateIntakes:
        error.receipt?.report?.capabilities?.formalCertificateIntakes,
    }, null, 2)}`);
  }
  assert.equal(researchResult.status, 'campaign_research_verification_completed');
  assert.equal(
    researchResult.report.capabilities.trustedFormalEvidence[0]?.status,
    'trusted_formal_evidence_projected',
  );
  assert.equal(researchResult.report.capabilities.formalCertificateIntakes.length, 1);
  assert.equal(
    researchResult.report.capabilities.formalCertificateIntakes[0]?.version,
    4,
  );
  assert.equal(
    researchResult.report.capabilities.formalCertificateIntakes[0]?.status,
    'formal_certificate_intake_verified',
  );
  assert.equal(
    researchResult.report.capabilities.formalCertificateIntakes[0]
      ?.authoritativeFormalNodeResultHash,
    hashRecord('PaperCampaignNodeResult', formalResult),
  );
  assert.equal(
    researchResult.report.capabilities.evidenceQualityGate
      .formalCertificateIntakeClosureVerifications[0]?.valid,
    true,
  );
  assert.equal(researchResult.researchNodeId, runningResearchNode.nodeId);
  assert.equal(researchResult.researchAttemptId, runningResearchNode.attemptId);
  assert.equal(researchResult.researchLeaseGeneration, runningResearchNode.leaseGeneration);
  assert.equal(researchResult.formalVerificationReceiptHash, formalResult.campaignFormalVerificationReceiptHash);
  assert.equal(researchResult.proposalClaimToTheoremBindingHash,
    formalResult.proposalClaimToTheoremBindingHash);
  assert.equal(researchResult.report.proposalClaimToTheoremBindingHash,
    formalResult.proposalClaimToTheoremBindingHash);
  assert.equal(researchResult.report.nativeResearchWorkerExecution.nativeResearchWorkerExecutionReportHash, formalResult.nativeResearchWorkerExecutionReportHash);
  const researchNode = campaignStore.completeNode({
    nodeId: runningResearchNode.nodeId,
    workerId: 'formal-worker',
    attemptId: runningResearchNode.attemptId,
    leaseGeneration: runningResearchNode.leaseGeneration,
    result: researchResult,
  });
  const finalOutputDirectory = path.join(workspace, 'automation-results', 'final');
  const finalCompile = spawnSync('/usr/bin/pdflatex', [
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-output-directory',
    finalOutputDirectory,
    path.join(workspace, 'main.tex'),
  ], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(finalCompile.status, 0, `${finalCompile.stdout}\n${finalCompile.stderr}`);
  const finalCompileResult = {
    status: 'empirical_execution_completed',
    materializedPaths: ['automation-results/final/main.pdf'],
    multiLanguageEmpiricalReceiptHash: hashRecord('FinalCompileFixture', {}),
    sourceMerkleHash: researchResult.verifiedSourceMerkleHash,
    sourceWorkspaceManifestHash: researchResult.verifiedSourceWorkspaceManifestHash,
  };
  const finalCompileNode = {
    ...completedFinalCompileNode, status: 'completed',
    result: finalCompileResult, resultSha256: hashRecord('PaperCampaignNodeResult', finalCompileResult),
  };
  const packageNode = {
    nodeId: 'campaign-formal:package',
    kind: 'package',
    status: 'running',
    roundIndex: 0,
    priority: 6,
    dependencies: [finalCompileNode.nodeId, researchNode.nodeId],
    attemptId: 'package-attempt-1',
    leaseGeneration: 1,
    updatedAt: '2026-07-14T00:30:00.000Z',
  };
  const packageResult = await executor.execute({
    campaign,
    node: packageNode,
    allNodes: [completedSpecificationNode, { ...formalVerifyNode, status: 'completed', result: formalResult }, finalCompileNode, researchNode, packageNode],
  });
  assert.equal(packageResult.status, 'campaign_release_prepared');
  assert.equal(packageResult.releaseBundle.researchReportHash, researchResult.researchReportHash);
  assert.equal(packageResult.releaseBundle.proposalClaimToTheoremBindingHash,
    formalResult.proposalClaimToTheoremBindingHash);
  assert.equal(packageResult.experimentRegistryHash, researchResult.experimentRegistryHash);
  assert.equal(packageResult.releaseBundle.experimentRegistryHash, researchResult.experimentRegistryHash);
  assert.equal(packageResult.releaseBundle.promotionCandidate.experimentRegistryHash, researchResult.experimentRegistryHash);
  assert.equal(packageResult.releaseBundle.researchReport.experimentRegistryHash, researchResult.experimentRegistryHash);
  assert.equal(packageResult.releaseBundle.researchReport.capabilities.experimentRegistry.experimentRegistryHash, researchResult.experimentRegistryHash);
  assert.equal(packageResult.releaseBundle.verifiedSourceMerkleHash, researchResult.verifiedSourceMerkleHash);
  assert.equal(packageResult.releaseBundle.verifiedSourceWorkspaceManifestHash, researchResult.verifiedSourceWorkspaceManifestHash);
  assert.equal(packageResult.releaseBundle.campaignResearchSourceSnapshotHash, researchResult.campaignResearchSourceSnapshotHash);
  assert.equal(packageResult.releaseBundle.researchVerifyNodeId, researchNode.nodeId);
  assert.equal(packageResult.releaseBundle.researchVerifyAttemptId, researchNode.attemptId);
  assert.equal(packageResult.releaseBundle.researchVerifyLeaseGeneration, researchNode.leaseGeneration);
  assert.equal(packageResult.releaseBundle.promotionCandidate.campaignResearchSourceSnapshotHash, researchResult.campaignResearchSourceSnapshotHash);
  assert.equal(packageResult.releaseBundle.researchReport.capabilities.formalReplayReceipts[0].status, 'formal_claim_replay_verified');
  assert.equal(packageResult.releaseBundle.manuscriptPromotionGate.status, 'manuscript_promotion_ready');
  const { campaignReleaseBundleHash: _claimedBundleHash, ...tamperedBundlePayload } = structuredClone(packageResult.releaseBundle);
  tamperedBundlePayload.experimentRegistryHash = `sha256:${'f'.repeat(64)}`;
  const tamperedBundle = {
    ...tamperedBundlePayload,
    campaignReleaseBundleHash: hashRecord('CampaignReleaseBundle', tamperedBundlePayload),
  };
  const tamperedVerification = verifyCampaignReleaseBundle(tamperedBundle, {
    campaignId: campaign.campaignId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    paperId: campaign.paperId,
    packageNodeId: packageNode.nodeId,
    packageAttemptId: packageNode.attemptId,
  });
  assert.equal(tamperedVerification.valid, false);
  assert.ok(tamperedVerification.blockers.includes('campaign_release_experiment_registry_binding_invalid'));
  const gateMirrorTamper = structuredClone(packageResult.releaseBundle);
  gateMirrorTamper.manuscriptPromotionGate.experimentRegistryHash = `sha256:${'e'.repeat(64)}`;
  const { manuscriptPromotionGateHash: _claimedGateHash, ...gatePayload } = gateMirrorTamper.manuscriptPromotionGate;
  gateMirrorTamper.manuscriptPromotionGate.manuscriptPromotionGateHash = hashRecord('ManuscriptPromotionGate', gatePayload);
  gateMirrorTamper.manuscriptPromotionGateHash = gateMirrorTamper.manuscriptPromotionGate.manuscriptPromotionGateHash;
  const { campaignReleaseBundleHash: _gateMirrorBundleHash, ...gateMirrorPayload } = gateMirrorTamper;
  gateMirrorTamper.campaignReleaseBundleHash = hashRecord('CampaignReleaseBundle', gateMirrorPayload);
  const gateMirrorVerification = verifyCampaignReleaseBundle(gateMirrorTamper);
  assert.equal(gateMirrorVerification.valid, false);
  assert.ok(gateMirrorVerification.blockers.includes('campaign_release_promotion_gate_experiment_registry_binding_invalid'));
});
