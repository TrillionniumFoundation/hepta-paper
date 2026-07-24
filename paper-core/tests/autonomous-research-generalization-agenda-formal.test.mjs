import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  verifyDynamicFormalClaimSeed,
} from '../../paper-domain/research/dynamic-formal-claim-seed-contract.mjs';
import { createAgentResearchContentProducer } from '../../paper-adapters/automation/agent-research-content-producer.mjs';
import { createAgentResearchAgendaProducer } from '../../paper-adapters/automation/agent-research-agenda-producer.mjs';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import {
  proposalClaimSourceFromAuthority,
  verifyScientificClaimLineageAuthority,
} from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import {
  buildFormalClaimContract,
  verifyFormalClaimContract,
} from '../../paper-domain/research/formal-claim-contract.mjs';
import { createProofObligationContracts } from '../../paper-domain/research/theorem-specification.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  genericManuscriptReleaseFixture,
  priorArtV2Fixture,
  productionAgentAuthorityBindingFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import {
  inspectAutonomousResearchProductionProfilePreparation,
} from '../../paper-domain/automation/autonomous-research-production-profile-contract.mjs';
import {
  buildAutonomousResearchAgentProductionAuthorityBinding,
} from '../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs';
import { buildResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  verifyResearchAgendaClaimBindingReceipt,
} from '../../paper-domain/automation/research-agenda-claim-binding-contract.mjs';

const FIXED_TIME = '2026-07-19T00:00:00.000Z';

function digest(label) {
  return hashRecord('AutonomousResearchGeneralizationFixture', { label });
}

test('production agenda and content producers are budgeted, idempotent, dynamic, and fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-agent-content-producer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const cacheRoot = path.join(root, 'content-cache');
  const agendaCacheRoot = path.join(root, 'agenda-cache');
  fs.mkdirSync(workspace);
  let calls = 0;
  let lastInput = null;
  let structuredOutput = {
    status: 'completed',
    summary: 'Generated one bounded empirical hypothesis and one Lean support claim.',
    checksRun: ['schema', 'scope'],
    blockers: [],
    empiricalHypothesis: {
      statement: 'The declared treatment improves bounded score relative to the control.',
      assumptions: ['The registered benchmark cases are available.'],
      quantifiers: ['For every registered deterministic seed.'],
      negativeBoundaries: ['No open-world superiority or causal claim is made.'],
      empiricalObligations: ['Execute treatment, control, and ablation with fixed metrics.'],
    },
    dynamicFormalClaim: {
      statement: 'Every natural number equals itself.',
      assumptions: ['The quantified value has type Nat.'],
      quantifiers: ['For every natural number n.'],
      negativeBoundaries: ['No empirical conclusion follows from this identity.'],
      proofObligations: ['Kernel replay verifies the exact normalized Lean type.'],
      leanDeclarationName: 'generatedIdentity',
      leanTypeSource: '∀ n : Nat, n = n',
      allowedImports: ['Mathlib'],
    },
  };
  const executor = {
    version: 1,
    kind: 'ResearchContentFixtureExecutor',
    executorId: 'research-content-fixture',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'research-content-fixture',
      sandboxModes: ['read-only'],
      networkPolicy: 'none',
      receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      calls += 1;
      lastInput = input;
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        status: 'agent_execution_completed',
        agentId: 'research-author-1',
        providerMode: 'fixture-agent',
        resolvedModel: 'research-content-v1',
        promptHash: digest(`content-prompt-${calls}`),
        changedPaths: [],
        structuredOutput: structuredClone(structuredOutput),
      };
      return Object.freeze({
        ...payload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
      });
    },
  };
  let agendaCalls = 0;
  let lastAgendaInput = null;
  const agendaExecutor = {
    ...executor,
    executorId: 'research-agenda-fixture',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'research-agenda-fixture',
      sandboxModes: ['read-only'],
      networkPolicy: 'none',
      receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      agendaCalls += 1;
      lastAgendaInput = input;
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        status: 'agent_execution_completed',
        agentId: 'research-author-1',
        providerMode: 'fixture-agent',
        resolvedModel: 'research-agenda-v1',
        promptHash: digest(`agenda-prompt-${agendaCalls}`),
        changedPaths: [],
        structuredOutput: {
          status: 'completed',
          summary: 'Selected one bounded agenda inside the allowed family.',
          checksRun: ['schema', 'family-scope'],
          blockers: [],
          objective: 'Evaluate a bounded deterministic treatment against a fixed control.',
          protocolFamily: 'rl_stochastic_control_benchmark',
          researchQuestion: 'Does the registered policy improve bounded return?',
          primaryClaim: 'The declared treatment improves bounded score relative to the control.',
          dataRequirements: {
            population: 'Signed benchmark episodes.',
            intervention: 'Registered treatment policy.',
            comparator: 'Registered control policy.',
            estimand: 'Paired mean bounded-return difference.',
            requiredVariables: ['episode_return', 'policy_assignment'],
            datasetConstraints: ['read-only signed mount'],
          },
          falsifiers: ['Non-positive paired bounded-return difference.'],
          negativeBoundaries: ['No claim outside the signed benchmark population.'],
          formalTargets: ['Every natural number equals itself.'],
          priorArtQueryPlan: ['Search the policy and bounded-return estimand together.'],
          venueConstraints: {
            paperType: 'research_article',
            requiredSections: ['methods', 'results', 'limitations'],
            artifactRequired: true,
            anonymousReviewRequired: true,
          },
          resourceFeasibility: {
            maximumWallTimeMs: 3_600_000,
            maximumMemoryBytes: 8_589_934_592,
            maximumCpuCount: 4,
            executionEnvironment: 'signed-python-runtime-v1',
          },
        },
      };
      return Object.freeze({
        ...payload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
      });
    },
  };
  const contentCapabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    scopeId: 'hepta.test.agent-content-production',
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1', 'registered-template-v1'],
    empiricalFamilies: ['rl_stochastic_control_benchmark'],
    priorArtMode: 'structured-ranked-deduplicated-v2',
    reviewerPrincipalCount: 1,
    reviewerTrustDomainCount: 1,
    replayMode: 'same-process-recomputation-v1',
    venueMode: 'disabled',
  });
  const producer = createAgentResearchContentProducer({
    agentExecutor: executor,
    workspacePath: workspace,
    cacheRoot,
    producerId: 'research-author-1',
    allowedProtocolFamilies: ['rl_stochastic_control_benchmark'],
    dynamicFormalClaimsEnabled: true,
    capabilityScopeManifestHash:
      contentCapabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    clock: { now: () => new Date(FIXED_TIME) },
  });
  const agendaProducer = createAgentResearchAgendaProducer({
    agentExecutor: agendaExecutor,
    workspacePath: workspace,
    cacheRoot: agendaCacheRoot,
    producerId: 'research-author-1',
    allowedProtocolFamilies: ['rl_stochastic_control_benchmark'],
    clock: { now: () => new Date(FIXED_TIME) },
  });
  const priorArtRetriever = Object.freeze({
    version: 1,
    kind: 'PriorArtRetrievalPort',
    cryptographicAuthorityReady: false,
    identityIndependenceReady: false,
    async retrieve(input) {
      return priorArtV2Fixture({
        paperId: input.paperId,
        agendaSelectionReceiptHash: input.agendaSelectionReceiptHash,
        researchAgendaIrHash: input.researchAgendaIrHash,
        priorArtQueryPlan: input.priorArtQueryPlan,
        createdAt: input.createdAt,
      });
    },
  });
  const request = {
    paperId: 'paper-agent-content-1',
    objective: 'Evaluate a bounded deterministic treatment against a fixed control.',
    protocolFamily: 'rl_stochastic_control_benchmark',
  };
  const first = await producer.produce(request);
  assert.equal(first.cacheHit, false);
  assert.equal(first.researchContentProducerReceipt.withinBudget, true);
  assert.equal(first.researchContentProducerReceipt.humanApprovalPerformed, false);
  assert.match(first.researchContentProducerReceipt.producerContractHash,
    /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.researchContentProducerReceipt.dynamicFormalClaimsEnabled, true);
  assert.equal(first.researchContentProducerReceipt.capabilityScopeManifestHash,
    contentCapabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash);
  assert.equal(verifyDynamicFormalClaimSeed(first.dynamicFormalClaimSeed).valid, true);
  assert.equal(lastInput.sandbox, 'read-only');
  assert.equal(lastInput.outputTokenBudget, 4096);
  assert.match(lastInput.instructions, /Do not claim novelty, scientific truth/);
  await assert.rejects(() => prepareAutonomousResearchLoop({
    ...request,
    hypothesisGenerator: producer,
    requireAgentAuthoredProse: true,
    declaredCapabilityScopeManifest: contentCapabilityScopeManifest,
    createdAt: FIXED_TIME,
  }), /autonomous_research_declared_capability_scope_invalid/);
  const prepared = await prepareAutonomousResearchLoop({
    ...request,
    researchAgendaProducer: agendaProducer,
    hypothesisGenerator: producer,
    priorArtRetriever,
    requireAgentAuthoredProse: true,
    declaredCapabilityScopeManifest: contentCapabilityScopeManifest,
    createdAt: FIXED_TIME,
  });
  assert.equal(prepared.proposal.formalSupportMode, 'dynamic-lean-type-v1');
  assert.equal(prepared.capabilityScopeManifest.agendaMode, 'machine-generated');
  assert.equal(prepared.capabilityScopeManifest.manuscriptMode,
    'agent-authored-evidence-bound-ir-v1');
  assert.equal(prepared.researchAgendaProducerReceipt.withinBudget, true);
  assert.equal(prepared.researchAgendaIr.protocolFamily,
    'rl_stochastic_control_benchmark');
  assert.equal(prepared.priorArtClaimAlignmentReceipt.status,
    'prior_art_claim_alignment_verified');
  assert.equal(prepared.priorArtClaimAlignmentReceipt.researchAgendaIrHash,
    prepared.researchAgendaIr.researchAgendaIrHash);
  assert.equal(prepared.priorArtClaimAlignmentReceipt.agendaSelectionReceiptHash,
    prepared.proposal.agendaSelectionReceiptHash);
  assert.equal(prepared.priorArtClaimAlignmentReceipt.scientificNoveltyVerified, false);
  assert.equal(prepared.agendaClaimBindingReceipt.status,
    'research_agenda_claim_binding_verified');
  assert.equal(prepared.agendaClaimBindingReceipt.researchAgendaIrHash,
    prepared.researchAgendaIr.researchAgendaIrHash);
  assert.equal(prepared.agendaClaimBindingReceipt.proposalHash,
    prepared.proposal.machineProposedScientificClaimSetHash);
  assert.equal(verifyResearchAgendaClaimBindingReceipt(
    prepared.agendaClaimBindingReceipt,
    { researchAgendaIr: prepared.researchAgendaIr, proposal: prepared.proposal },
  ).valid, true);
  assert.equal(verifyResearchAgendaClaimBindingReceipt({
    ...prepared.agendaClaimBindingReceipt,
    empiricalClaimRecordHash: digest('substituted-empirical-claim'),
  }, {
    researchAgendaIr: prepared.researchAgendaIr,
    proposal: prepared.proposal,
  }).valid, false);
  assert.match(prepared.researchAgendaProducerReceipt.producerContractHash,
    /^sha256:[0-9a-f]{64}$/);
  assert.equal(prepared.proposal.objective,
    'Evaluate a bounded deterministic treatment against a fixed control.');
  assert.equal(lastAgendaInput.sandbox, 'read-only');
  assert.equal(lastAgendaInput.outputTokenBudget, 2048);
  assert.equal(agendaCalls, 1);
  const agendaReplay = await agendaProducer.produce({
    paperId: request.paperId,
    objectiveHint: request.objective,
    protocolFamilyHint: request.protocolFamily,
  });
  assert.equal(agendaReplay.cacheHit, true);
  assert.equal(agendaReplay.researchAgendaIr.researchAgendaIrHash,
    prepared.researchAgendaIr.researchAgendaIrHash);
  assert.equal(agendaCalls, 1);
  assert.notEqual(prepared.researchContentProducerReceipt
    .autonomousResearchContentProductionReceiptHash,
  first.researchContentProducerReceipt.autonomousResearchContentProductionReceiptHash);
  assert.match(lastInput.instructions, /Copy the empiricalHypothesis\.statement exactly/);
  const mismatchedResearchAgendaIr = buildResearchAgendaIr({
    agendaProductionReceipt: agendaReplay.researchAgendaProducerReceipt,
    researchQuestion: prepared.researchAgendaIr.researchQuestion,
    primaryClaim: 'The registered policy improves bounded return against the control.',
    dataRequirements: prepared.researchAgendaIr.dataRequirements,
    falsifiers: prepared.researchAgendaIr.falsifiers,
    negativeBoundaries: prepared.researchAgendaIr.negativeBoundaries,
    formalTargets: ['Kernel-check the registered policy invariant.'],
    priorArtQueryPlan: prepared.researchAgendaIr.priorArtQueryPlan,
    venueConstraints: prepared.researchAgendaIr.venueConstraints,
    resourceFeasibility: prepared.researchAgendaIr.resourceFeasibility,
  });
  const mismatchedAgendaProducer = Object.freeze({
    producerId: 'research-author-1',
    async produce() {
      return Object.freeze({
        ...agendaReplay,
        researchAgendaIr: mismatchedResearchAgendaIr,
      });
    },
  });
  await assert.rejects(() => prepareAutonomousResearchLoop({
    ...request,
    researchAgendaProducer: mismatchedAgendaProducer,
    hypothesisGenerator: producer,
    priorArtRetriever,
    requireAgentAuthoredProse: true,
    declaredCapabilityScopeManifest: contentCapabilityScopeManifest,
    createdAt: FIXED_TIME,
  }), (error) => {
    assert.match(error.message, /autonomous_research_agenda_claim_binding_blocked/);
    assert.match(error.message, /research_agenda_claim_binding_primary_claim_mismatch/);
    assert.match(error.message, /research_agenda_claim_binding_formal_target_mismatch/);
    return true;
  });
  const lineageAuthority = verifyScientificClaimLineageAuthority({
    scientificClaimAuthority: prepared.seedBinding,
    seedContractBundle: prepared.seedBundle,
    paperId: request.paperId,
  });
  assert.equal(lineageAuthority.valid, true);
  const dynamicSource = proposalClaimSourceFromAuthority(lineageAuthority.claims[0]);
  assert.equal(dynamicSource.dynamicFormalClaimSeedHash,
    prepared.dynamicFormalClaimSeed.dynamicFormalClaimSeedHash);
  const templatePaperId = `${request.paperId}-template-lineage`;
  const templatePreparation = await prepareAutonomousResearchLoop({
    paperId: templatePaperId,
    objective: 'Evaluate a deterministic estimator under a fixed benchmark.',
    protocolFamily: 'ml_algorithm_benchmark',
    createdAt: FIXED_TIME,
  });
  const templateAuthority = verifyScientificClaimLineageAuthority({
    scientificClaimAuthority: templatePreparation.seedBinding,
    seedContractBundle: templatePreparation.seedBundle,
    paperId: templatePaperId,
  });
  assert.equal(templateAuthority.valid, true, JSON.stringify(templateAuthority.blockers));
  const templateSource = proposalClaimSourceFromAuthority(templateAuthority.claims[0]);
  assert.equal(templateSource.claimAuthorityType, 'machine-policy-authorized');
  assert.equal(templateSource.dynamicFormalClaimSeedHash, undefined);
  const proofObligationContracts = createProofObligationContracts({
    claimKey: dynamicSource.scientificClaimKey,
    proofObligations: dynamicSource.proofObligations,
  });
  const proofObligationMappings = proofObligationContracts.map((contract) => ({
    ...contract,
    leanDeclarations: [dynamicSource.leanDeclarationName],
  }));
  const semanticReview = {
    status: 'formal_semantic_review_verified',
    reviewerId: 'independent-reviewer-1',
    authorId: 'research-author-1',
    semanticEquivalenceVerified: true,
    reviewReceiptHash: digest('dynamic-review'),
    reviewEnvelopeHash: digest('dynamic-review-envelope'),
    reviewNodeId: 'formal-review-1',
    reviewAttemptId: 'formal-review-attempt-1',
    reviewAgentReceiptHash: digest('dynamic-review-agent'),
    authorNodeId: 'formal-author-1',
    authorAgentReceiptHash: digest('dynamic-author-agent'),
    reviewedManuscriptHash: digest('dynamic-manuscript'),
    reviewedWorkerPlanHash: digest('dynamic-worker-plan'),
  };
  const dynamicContract = buildFormalClaimContract({
    claimId: 'dynamic-formal-claim-1',
    claimText: dynamicSource.proposalClaimText,
    sourceLocator: 'main.tex#dynamic-formal-claim-1',
    theoremName: dynamicSource.leanDeclarationName,
    theoremTypeHash: dynamicSource.leanNormalizedTypeHash,
    sourceStatementHash: digest('dynamic-source-statement'),
    proofObligations: dynamicSource.proofObligations,
    proofObligationContracts,
    proofObligationMappings,
    manuscriptSourceIdentity: {
      path: 'main.tex',
      byteStart: 10,
      byteEnd: 100,
      contentHash: digest('dynamic-claim-content'),
      fileHash: digest('dynamic-manuscript-file'),
    },
    dynamicFormalClaimAuthority: dynamicSource,
    semanticReview,
  });
  assert.equal(verifyFormalClaimContract(dynamicContract, {
    dynamicFormalClaimSeedHash: dynamicSource.dynamicFormalClaimSeedHash,
    theoremName: dynamicSource.leanDeclarationName,
    theoremTypeHash: dynamicSource.leanNormalizedTypeHash,
  }).valid, true);
  assert.equal(buildFormalClaimContract({
    ...dynamicContract,
    theoremName: 'substitutedTheorem',
    dynamicFormalClaimAuthority: dynamicSource,
  }).status, 'formal_claim_contract_blocked');

  const second = await producer.produce(request);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 3);
  const cacheFile = fs.readdirSync(cacheRoot).find((name) => {
    const cached = JSON.parse(fs.readFileSync(path.join(cacheRoot, name), 'utf8'));
    return cached.receipt.autonomousResearchContentProductionReceiptHash
      === first.researchContentProducerReceipt.autonomousResearchContentProductionReceiptHash;
  });
  assert.ok(cacheFile);
  const corruptedCache = JSON.parse(fs.readFileSync(path.join(cacheRoot, cacheFile), 'utf8'));
  corruptedCache.receipt.autonomousResearchContentProductionReceiptHash = digest('corrupt-cache');
  fs.writeFileSync(path.join(cacheRoot, cacheFile), JSON.stringify(corruptedCache));
  const rebuilt = await producer.produce(request);
  assert.equal(rebuilt.cacheHit, false);
  assert.equal(calls, 4);

  structuredOutput = { ...structuredOutput, status: 'blocked', blockers: ['model_declined'] };
  await assert.rejects(() => producer.produce({
    ...request,
    paperId: 'paper-agent-content-2',
  }), /agent_research_content_structured_output_blocked/);
});

test('durable agenda and content caches are scoped to the pinned production author authority', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-agent-authority-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const agendaCacheRoot = path.join(root, 'agenda-cache');
  const contentCacheRoot = path.join(root, 'content-cache');
  fs.mkdirSync(workspace);
  const family = 'rl_stochastic_control_benchmark';
  const paperId = 'paper-agent-authority-cache';
  const objective = 'Evaluate a bounded treatment against a fixed control.';
  const capabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    scopeId: 'hepta.test.agent-authority-cache',
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1'],
    empiricalFamilies: [family],
    priorArtMode: 'opaque-hash-v1',
    reviewerPrincipalCount: 1,
    reviewerTrustDomainCount: 1,
    replayMode: 'same-process-recomputation-v1',
    venueMode: 'disabled',
  });
  const baseline = productionAgentAuthorityBindingFixture();
  const bindings = [
    baseline,
    productionAgentAuthorityBindingFixture({
      providerConfigurationHash: digest('rotated-provider-configuration'),
    }),
    productionAgentAuthorityBindingFixture({ authorPrincipalId: 'research-author-rotated' }),
    productionAgentAuthorityBindingFixture({ authorProvider: 'rotated-agent-provider' }),
    productionAgentAuthorityBindingFixture({ authorModel: 'pinned-research-model-v2' }),
    productionAgentAuthorityBindingFixture({
      authorCapabilityReceiptHash: digest('rotated-author-capability'),
      authorCredentialRootIdentityHash: digest('rotated-author-credential-root'),
      authorCredentialConfigIdentityHash: digest('rotated-author-credential-config'),
    }),
  ];
  let agendaCalls = 0;
  let contentCalls = 0;
  const executorFor = (binding, role) => Object.freeze({
    version: 1,
    kind: 'ProductionAuthorityFixtureExecutor',
    executorId: `authority-fixture:${role}:${binding.authorPrincipalId}`,
    capabilities: () => buildExecutorCapabilities({
      executorId: `authority-fixture:${role}:${binding.authorPrincipalId}`,
      sandboxModes: ['read-only'],
      networkPolicy: 'none',
      receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute() {
      if (role === 'agenda') agendaCalls += 1;
      else contentCalls += 1;
      const structuredOutput = role === 'agenda' ? {
        status: 'completed',
        summary: 'Selected one bounded production agenda.',
        checksRun: ['schema'],
        blockers: [],
        objective,
        protocolFamily: family,
      } : {
        status: 'completed',
        summary: 'Generated bounded production content.',
        checksRun: ['schema'],
        blockers: [],
        empiricalHypothesis: {
          statement: 'The treatment improves the bounded score relative to control.',
          assumptions: ['The registered benchmark is available.'],
          quantifiers: ['For every registered deterministic seed.'],
          negativeBoundaries: ['No open-world superiority claim is made.'],
          empiricalObligations: ['Execute treatment and control with fixed metrics.'],
        },
        dynamicFormalClaim: {
          statement: 'Every natural number equals itself.',
          assumptions: ['The quantified value has type Nat.'],
          quantifiers: ['For every natural number n.'],
          negativeBoundaries: ['No empirical conclusion follows.'],
          proofObligations: ['Kernel replay verifies the normalized type.'],
          leanDeclarationName: 'authorityBoundIdentity',
          leanTypeSource: '∀ n : Nat, n = n',
          allowedImports: ['Mathlib'],
        },
      };
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        status: 'agent_execution_completed',
        agentId: binding.authorPrincipalId,
        providerMode: binding.authorProvider,
        resolvedModel: binding.authorModel,
        promptHash: digest(`${role}:${binding.autonomousResearchAgentProductionAuthorityBindingHash}`),
        changedPaths: [],
        structuredOutput,
        codexResearchAuthorCapabilityReceiptHash: binding.authorCapabilityReceiptHash,
        codexCredentialRootIdentityHash: binding.authorCredentialRootIdentityHash,
        codexCredentialConfigIdentityHash: binding.authorCredentialConfigIdentityHash,
      };
      return Object.freeze({
        ...payload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
      });
    },
  });
  const producersFor = (binding) => ({
    agenda: createAgentResearchAgendaProducer({
      agentExecutor: executorFor(binding, 'agenda'),
      workspacePath: workspace,
      cacheRoot: agendaCacheRoot,
      producerId: binding.authorPrincipalId,
      allowedProtocolFamilies: [family],
      productionAuthorityBinding: binding,
      clock: { now: () => new Date(FIXED_TIME) },
    }),
    content: createAgentResearchContentProducer({
      agentExecutor: executorFor(binding, 'content'),
      workspacePath: workspace,
      cacheRoot: contentCacheRoot,
      producerId: binding.authorPrincipalId,
      allowedProtocolFamilies: [family],
      productionAuthorityBinding: binding,
      dynamicFormalClaimsEnabled: true,
      capabilityScopeManifestHash:
        capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
      clock: { now: () => new Date(FIXED_TIME) },
    }),
  });
  for (const [index, binding] of bindings.entries()) {
    const producers = producersFor(binding);
    const agenda = await producers.agenda.produce({ paperId });
    const content = await producers.content.produce({ paperId, objective, protocolFamily: family });
    assert.equal(agenda.cacheHit, false, `agenda rotation ${index} must miss`);
    assert.equal(content.cacheHit, false, `content rotation ${index} must miss`);
    assert.equal(agenda.request.productionAuthorityBinding
      .autonomousResearchAgentProductionAuthorityBindingHash,
    binding.autonomousResearchAgentProductionAuthorityBindingHash);
    assert.equal(content.researchContentProducerReceipt.productionAuthorityBinding
      .autonomousResearchAgentProductionAuthorityBindingHash,
    binding.autonomousResearchAgentProductionAuthorityBindingHash);
  }
  for (const selectedCacheRoot of [agendaCacheRoot, contentCacheRoot]) {
    const rootStat = fs.lstatSync(selectedCacheRoot);
    assert.equal(rootStat.mode & 0o7777, 0o700);
    if (typeof process.getuid === 'function') assert.equal(rootStat.uid, process.getuid());
    for (const name of fs.readdirSync(selectedCacheRoot)) {
      const entryStat = fs.lstatSync(path.join(selectedCacheRoot, name));
      assert.equal(entryStat.mode & 0o7777, 0o600);
      if (typeof process.getuid === 'function') assert.equal(entryStat.uid, process.getuid());
    }
  }
  const callsAfterRotations = { agendaCalls, contentCalls };
  const restarted = producersFor(baseline);
  assert.equal((await restarted.agenda.produce({ paperId })).cacheHit, true);
  const baselineRestartedContent = await restarted.content.produce({
    paperId, objective, protocolFamily: family,
  });
  assert.equal(baselineRestartedContent.cacheHit, true);
  assert.deepEqual({ agendaCalls, contentCalls }, callsAfterRotations);
  const baselineContentFile = fs.readdirSync(contentCacheRoot).find((name) => {
    const cached = JSON.parse(fs.readFileSync(path.join(contentCacheRoot, name), 'utf8'));
    return cached.request.productionAuthorityBinding
      .autonomousResearchAgentProductionAuthorityBindingHash
      === baseline.autonomousResearchAgentProductionAuthorityBindingHash;
  });
  const hardlink = path.join(root, 'untrusted-content-cache-hardlink.json');
  fs.linkSync(path.join(contentCacheRoot, baselineContentFile), hardlink);
  const contentCallsBeforeHardlink = contentCalls;
  const hardenedRestart = producersFor(baseline);
  assert.equal((await hardenedRestart.content.produce({
    paperId, objective, protocolFamily: family,
  })).cacheHit, false);
  assert.equal(contentCalls, contentCallsBeforeHardlink + 1);
  fs.unlinkSync(hardlink);
  const symlinkedCacheRoot = path.join(root, 'symlinked-content-cache');
  fs.symlinkSync(contentCacheRoot, symlinkedCacheRoot, 'dir');
  assert.throws(() => createAgentResearchContentProducer({
    agentExecutor: executorFor(baseline, 'content'),
    workspacePath: workspace,
    cacheRoot: symlinkedCacheRoot,
    producerId: baseline.authorPrincipalId,
    allowedProtocolFamilies: [family],
    productionAuthorityBinding: baseline,
  }), /agent_production_cache_root_invalid/);
  fs.chmodSync(contentCacheRoot, 0o750);
  assert.throws(() => createAgentResearchContentProducer({
    agentExecutor: executorFor(baseline, 'content'),
    workspacePath: workspace,
    cacheRoot: contentCacheRoot,
    producerId: baseline.authorPrincipalId,
    allowedProtocolFamilies: [family],
    productionAuthorityBinding: baseline,
  }), /agent_production_cache_root_invalid/);
  fs.chmodSync(contentCacheRoot, 0o700);
  for (const cacheRoot of [agendaCacheRoot, contentCacheRoot]) {
    const cached = fs.readdirSync(cacheRoot).map((name) => (
      JSON.parse(fs.readFileSync(path.join(cacheRoot, name), 'utf8'))
    ));
    assert.equal(cached.length, bindings.length);
    assert.equal(new Set(cached.map((entry) => entry.request.idempotencyKey)).size,
      bindings.length);
    assert.ok(cached.every((entry) => entry.request.productionAuthorityBinding
      .autonomousResearchAgentProductionAuthorityBindingHash
      === entry.receipt.productionAuthorityBinding
        .autonomousResearchAgentProductionAuthorityBindingHash));
  }
  const rotatedCapabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    scopeId: 'hepta.test.agent-authority-cache-rotated',
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1'],
    empiricalFamilies: [family],
    priorArtMode: 'opaque-hash-v1',
    reviewerPrincipalCount: 1,
    reviewerTrustDomainCount: 1,
    replayMode: 'same-process-recomputation-v1',
    venueMode: 'disabled',
  });
  const contentCallsBeforeCapabilityRotation = contentCalls;
  const rotatedCapabilityProducer = createAgentResearchContentProducer({
    agentExecutor: executorFor(baseline, 'content'),
    workspacePath: workspace,
    cacheRoot: contentCacheRoot,
    producerId: baseline.authorPrincipalId,
    allowedProtocolFamilies: [family],
    productionAuthorityBinding: baseline,
    dynamicFormalClaimsEnabled: true,
    capabilityScopeManifestHash:
      rotatedCapabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    clock: { now: () => new Date(FIXED_TIME) },
  });
  const rotatedCapabilityResult = await rotatedCapabilityProducer.produce({
    paperId, objective, protocolFamily: family,
  });
  assert.equal(rotatedCapabilityResult.cacheHit, false);
  assert.equal(contentCalls, contentCallsBeforeCapabilityRotation + 1);
  assert.equal(rotatedCapabilityResult.researchContentProducerReceipt
    .capabilityScopeManifestHash,
  rotatedCapabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash);
  assert.equal(rotatedCapabilityResult.dynamicFormalClaimSeed.capabilityScopeManifestHash,
    rotatedCapabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash);
  assert.notEqual(rotatedCapabilityResult.researchContentProducerReceipt
    .producerContractHash,
  baselineRestartedContent.researchContentProducerReceipt.producerContractHash);
  assert.equal((await rotatedCapabilityProducer.produce({
    paperId, objective, protocolFamily: family,
  })).cacheHit, true);
});

test('production profile rejects injected receipts with free author fields under the same runtime binding', () => {
  const strong = genericManuscriptReleaseFixture({
    paperId: 'paper-agent-authority-profile',
    campaignId: 'campaign-agent-authority-profile',
    launchMode: 'production-run',
  });
  const strongPreparation = strong.preparation;
  assert.equal(
    inspectAutonomousResearchProductionProfilePreparation(strongPreparation).ready,
    true,
  );
  const expectedBinding = strongPreparation.productionAuthorityBinding;
  const rotatedBinding = buildAutonomousResearchAgentProductionAuthorityBinding({
    ...expectedBinding,
    authorModel: 'attacker-selected-model-under-the-same-runtime-binding',
  });
  assert.equal(rotatedBinding.runtimePrincipalBindingHash,
    expectedBinding.runtimePrincipalBindingHash);
  assert.equal(rotatedBinding.autonomousResearchProviderConfigurationHash,
    expectedBinding.autonomousResearchProviderConfigurationHash);
  assert.notEqual(rotatedBinding.autonomousResearchAgentProductionAuthorityBindingHash,
    expectedBinding.autonomousResearchAgentProductionAuthorityBindingHash);
  const {
    autonomousResearchAgendaProductionReceiptHash: _oldAgendaHash,
    ...agendaPayload
  } = strongPreparation.researchAgendaProducerReceipt;
  const rotatedAgendaPayload = Object.freeze({
    ...agendaPayload,
    model: rotatedBinding.authorModel,
    productionAuthorityBinding: rotatedBinding,
  });
  const rotatedAgendaReceipt = Object.freeze({
    ...rotatedAgendaPayload,
    autonomousResearchAgendaProductionReceiptHash: hashRecord(
      'AutonomousResearchAgendaProductionReceipt',
      rotatedAgendaPayload,
    ),
  });
  const {
    autonomousResearchContentProductionReceiptHash: _oldHash,
    ...contentPayload
  } = strongPreparation.researchContentProducerReceipt;
  const rotatedPayload = Object.freeze({
    ...contentPayload,
    model: rotatedBinding.authorModel,
    productionAuthorityBinding: rotatedBinding,
  });
  const rotatedReceipt = Object.freeze({
    ...rotatedPayload,
    autonomousResearchContentProductionReceiptHash: hashRecord(
      'AutonomousResearchContentProductionReceipt',
      rotatedPayload,
    ),
  });
  const inspection = inspectAutonomousResearchProductionProfilePreparation({
    ...strongPreparation,
    researchAgendaProducerReceipt: rotatedAgendaReceipt,
    proposal: {
      ...strongPreparation.proposal,
      researchContentProducerReceipt: rotatedReceipt,
    },
    researchContentProducerReceipt: rotatedReceipt,
  });
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes(
    'autonomous_research_production_agent_authority_binding_required',
  ));
});
