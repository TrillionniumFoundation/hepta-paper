import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createAgentResearchContentProducer } from '../../paper-adapters/automation/agent-research-content-producer.mjs';
import { buildCampaignFormalReviewEnvelope } from '../../paper-adapters/automation/campaign-formal-review-envelope.mjs';
import {
  finalizeTheoremSpecification,
  readFinalizedTheoremSpecification,
} from '../../paper-adapters/automation/theorem-specification-finalizer.mjs';
import { canonicalClaimsFromWorkerPlan } from '../../paper-adapters/research-verify/canonical-claim-registry-reader.mjs';
import { createLeanToolchainIdentityProvider } from '../../paper-adapters/research-verify/lean-toolchain-identity.mjs';
import { createLakeFormalVerifier } from '../../paper-adapters/research-verify/lake-formal-verifier.mjs';
import { executeLakeFormalWorker } from '../../paper-adapters/research-verify/lake-formal-worker.mjs';
import {
  independentlyVerifyFormalReadableProofWorkerResult,
} from '../../paper-adapters/research-verify/formal-readable-proof-verifier.mjs';
import { leanSourceDeclarationRecords } from '../../paper-adapters/research-verify/lean-source-contracts.mjs';
import { resolvePinnedLakeExecutable } from '../../paper-adapters/research-verify/pinned-lake-executable-resolver.mjs';
import {
  inspectConfiguredPinnedFormalSandboxRuntime,
} from '../../paper-adapters/research-verify/pinned-formal-sandbox-runtime-configuration.mjs';
import {
  bindFormalReviewsToWorkers,
} from '../../paper-adapters/research-verify/worker-runtime.mjs';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  buildAutonomousFormalSupportSurfaceAuthority,
  verifyAutonomousFormalSupportSurfaceAuthority,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import {
  PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import {
  buildDynamicFormalClaimSeed,
  dynamicFormalLeanTypeSourceValid,
  verifyDynamicFormalClaimSeed,
} from '../../paper-domain/research/dynamic-formal-claim-seed-contract.mjs';
import {
  buildFormalClaimContract,
  verifyFormalClaimContract,
} from '../../paper-domain/research/formal-claim-contract.mjs';
import { leanTypeIdentity } from '../../paper-domain/research/lean-type-identity.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const FIXED_TIME = '2026-07-19T00:00:00.000Z';

function digest(label) {
  return hashRecord('DynamicFormalClaimKernelE2eFixture', { label });
}

function formalAgentReceipt({ agentId, role, structuredOutput = null, changedPaths = [] }) {
  const payload = {
    status: 'agent_execution_completed',
    providerMode: 'openclaw:detached-child-session',
    executorId: 'dynamic-formal-kernel-e2e-agent-v1',
    agentId,
    agentCapabilityProfileHash: digest(`capability:${agentId}`),
    openClawAgentConfigurationHash: digest(`configuration:${agentId}`),
    openClawGatewayConfigurationHash: digest('gateway'),
    resolvedModel: 'fixture-model',
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

function trustedProductionLakePreflight() {
  const runtime = resolvePinnedLakeExecutable();
  if (runtime.status !== 'formal_pinned_lake_resolved') {
    return { ready: false, reason: runtime.blockers.join(',') || runtime.status };
  }
  const probe = spawnSync(runtime.executable, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, ELAN_TOOLCHAIN: runtime.toolchain },
    timeout: 10_000,
  });
  if (probe.status !== 0 || probe.error) {
    return {
      ready: false,
      reason: String(probe.error?.message || probe.stderr || probe.stdout || 'lake_version_probe_failed').trim(),
    };
  }
  const identity = createLeanToolchainIdentityProvider({
    toolchain: runtime.toolchain,
    toolchainRoot: runtime.toolchainRoot,
    leanExecutable: runtime.leanExecutable,
    lakeExecutable: runtime.lakeExecutable,
    expectedToolchainRootMerkleHash:
      PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[runtime.toolchain] || null,
  }).inspect();
  if (identity.status !== 'lean_toolchain_identity_verified') {
    return { ready: false, reason: identity.blockers.join(',') || identity.status };
  }
  const formalSandbox = inspectConfiguredPinnedFormalSandboxRuntime({
    environment: process.env,
  });
  if (!formalSandbox.ready) {
    return {
      ready: false,
      reason: formalSandbox.blockers.join(',') || 'os_sandbox_runtime_unavailable',
    };
  }
  return {
    ready: true,
    runtime,
    identity,
    sandbox: formalSandbox.sandbox,
    formalSandboxRuntime: formalSandbox.runtime,
  };
}

test('dynamic exact-type audit rejects agent command and comment injection before execution', async (t) => {
  const maliciousTypes = [
    'True)\n#check False --',
    'True) run_tac Lean.Elab.Command.liftTermElabM do pure ()',
    'True -- hide the system-owned closing delimiter',
  ];
  for (const leanTypeSource of maliciousTypes) {
    assert.equal(dynamicFormalLeanTypeSourceValid(leanTypeSource), false);
    assert.throws(() => buildDynamicFormalClaimSeed({
      claimKey: 'malicious-dynamic-claim',
      statement: 'A malicious claim must not reach Lean execution.',
      assumptions: ['The input came from an untrusted agent.'],
      quantifiers: ['For the supplied candidate.'],
      negativeBoundaries: ['No injected command is authorized.'],
      proofObligations: ['Reject unsafe type source before execution.'],
      leanDeclarationName: 'target',
      leanTypeSource,
      allowedImports: ['Init'],
      generatorReceiptHash: digest('malicious-generator'),
      capabilityScopeManifestHash: digest('malicious-scope'),
    }), /dynamic_formal_claim_seed_invalid/);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dynamic-formal-injection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'lakefile.lean'), [
    'import Lake', 'open Lake DSL', 'package heptaDynamicInjection where',
    '@[default_target]', 'lean_lib Main where', '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'lean-toolchain'), 'leanprover/lean4:v4.30.0\n');
  fs.writeFileSync(path.join(root, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.1.0', packagesDir: '.lake/packages', packages: [],
    name: 'heptaDynamicInjection', lakeDir: '.lake',
  }, null, 2)}\n`);
  const source = 'import Init\ntheorem target : True := True.intro\n';
  fs.writeFileSync(path.join(root, 'Main.lean'), source);
  const declaration = leanSourceDeclarationRecords(source).find((item) => item.name === 'target');
  const maliciousTypeSource = maliciousTypes[0];
  const maliciousTypeHash = leanTypeIdentity(maliciousTypeSource).normalizedTypeHash;
  const manuscriptSourceIdentity = {
    path: 'main.tex', byteStart: 1, byteEnd: 2,
    contentHash: digest('malicious-claim-content'),
    fileHash: digest('malicious-manuscript'),
  };
  const semanticReview = {
    status: 'formal_semantic_review_verified',
    reviewerId: 'independent-reviewer',
    authorId: 'untrusted-author',
    semanticEquivalenceVerified: true,
    reviewReceiptHash: digest('malicious-review'),
    reviewEnvelopeHash: digest('malicious-review-envelope'),
    reviewNodeId: 'malicious-review-node',
    reviewAttemptId: 'malicious-review-attempt',
    reviewAgentReceiptHash: digest('malicious-review-agent'),
    authorNodeId: 'malicious-author-node',
    authorAgentReceiptHash: digest('malicious-author-agent'),
    reviewedManuscriptHash: digest('malicious-manuscript'),
    reviewedWorkerPlanHash: digest('malicious-worker-plan'),
  };
  const blockedContract = buildFormalClaimContract({
    claimId: 'claim-malicious-dynamic-type',
    claimText: 'The injected type must be rejected.',
    sourceLocator: 'main.tex#claim',
    theoremName: 'target',
    theoremTypeHash: maliciousTypeHash,
    sourceStatementHash: declaration.statementHash,
    proofObligations: ['Reject unsafe type source before execution.'],
    manuscriptSourceIdentity,
    dynamicFormalClaimAuthority: {
      dynamicFormalClaimSeedHash: digest('malicious-seed'),
      leanDeclarationName: 'target',
      leanTypeSource: maliciousTypeSource,
      leanTypeSourceHash: hashBytes(Buffer.from(maliciousTypeSource)),
      leanNormalizedTypeHash: maliciousTypeHash,
      allowedImports: ['Init'],
      formalClaimCapabilityScopeManifestHash: digest('malicious-scope'),
      formalClaimGeneratorReceiptHash: digest('malicious-generator'),
    },
    semanticReview,
  });
  assert.equal(blockedContract.status, 'formal_claim_contract_blocked');
  assert.ok(blockedContract.blockers.includes('formal_dynamic_claim_authority_invalid'));

  let runnerCalled = false;
  const toolchainIdentity = Object.freeze({
    status: 'lean_toolchain_identity_verified',
    toolchain: 'leanprover/lean4:v4.30.0',
    leanToolchainContentIdentityHash: digest('injection-toolchain'),
    blockers: [],
  });
  const verifier = createLakeFormalVerifier({
    projectRoot: root,
    commandRunner: {
      run() {
        runnerCalled = true;
        throw new Error('unsafe_dynamic_type_reached_runner');
      },
    },
    toolchainIdentityProvider: { inspect: () => toolchainIdentity },
  });
  const result = await verifier.verify({
    claimBindings: [{
      claimId: 'claim-malicious-dynamic-type',
      theoremName: 'target',
      sourceFile: 'Main.lean',
      expectedTypeHash: maliciousTypeHash,
      sourceStatementHash: declaration.statementHash,
      proofObligations: ['Reject unsafe type source before execution.'],
      manuscriptClaimHash: blockedContract.manuscriptClaimHash,
      formalClaimContract: blockedContract,
    }],
  });
  assert.equal(result.status, 'formal_verifier_blocked');
  assert.ok(result.blockers.includes('formal_system_audit_contract_invalid'));
  assert.equal(runnerCalled, false);

  const safeTypeSource = 'True';
  const safeTypeHash = leanTypeIdentity(safeTypeSource).normalizedTypeHash;
  const importBlockedContract = buildFormalClaimContract({
    claimId: 'claim-unlisted-dynamic-import',
    claimText: 'The dynamic source import must be allowlisted.',
    sourceLocator: 'main.tex#claim',
    theoremName: 'target',
    theoremTypeHash: safeTypeHash,
    sourceStatementHash: declaration.statementHash,
    proofObligations: ['Reject unlisted imports before execution.'],
    manuscriptSourceIdentity,
    dynamicFormalClaimAuthority: {
      dynamicFormalClaimSeedHash: digest('import-seed'),
      leanDeclarationName: 'target',
      leanTypeSource: safeTypeSource,
      leanTypeSourceHash: hashBytes(Buffer.from(safeTypeSource)),
      leanNormalizedTypeHash: safeTypeHash,
      allowedImports: ['Mathlib'],
      formalClaimCapabilityScopeManifestHash: digest('import-scope'),
      formalClaimGeneratorReceiptHash: digest('import-generator'),
    },
    semanticReview,
  });
  assert.equal(importBlockedContract.status, 'formal_claim_contract_verified');
  const importBlockedResult = await verifier.verify({
    claimBindings: [{
      claimId: 'claim-unlisted-dynamic-import',
      theoremName: 'target',
      sourceFile: 'Main.lean',
      expectedTypeHash: safeTypeHash,
      sourceStatementHash: declaration.statementHash,
      proofObligations: ['Reject unlisted imports before execution.'],
      manuscriptClaimHash: importBlockedContract.manuscriptClaimHash,
      formalClaimContract: importBlockedContract,
    }],
  });
  assert.equal(importBlockedResult.status, 'formal_verifier_blocked');
  assert.ok(importBlockedResult.blockers.includes(
    'formal_dynamic_claim_import_not_allowed:claim-unlisted-dynamic-import',
  ));
  assert.equal(runnerCalled, false);
});

test('agent-authored dynamic Lean claim closes through canonical bindings, the real kernel, and fresh replay', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const preflight = trustedProductionLakePreflight();
  if (!preflight.ready) {
    if (process.env.HEPTA_DYNAMIC_FORMAL_KERNEL_OPERATIONAL_MODE === 'strict') {
      throw new Error(`dynamic_formal_kernel_operational_prerequisite_failed:${preflight.reason}`);
    }
    t.skip(`trusted production Lake unavailable: ${preflight.reason}`);
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dynamic-formal-kernel-e2e-'));
  const workspace = path.join(root, 'source');
  const cacheRoot = path.join(root, 'content-cache');
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const paperId = 'paper-dynamic-formal-kernel';
  const campaignId = 'campaign-dynamic-formal-kernel';
  const protocolFamily = 'rl_stochastic_control_benchmark';
  const objective = 'Evaluate one bounded deterministic treatment against a fixed control.';
  const capabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    scopeId: 'hepta.test.dynamic-formal-kernel-e2e',
    agendaMode: 'registered-profile',
    manuscriptMode: 'minimal-report-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1', 'registered-template-v1'],
    empiricalFamilies: [protocolFamily],
    priorArtMode: 'opaque-hash-v1',
    reviewerPrincipalCount: 1,
    reviewerTrustDomainCount: 1,
    replayMode: 'same-process-recomputation-v1',
    venueMode: 'disabled',
  });
  let contentAgentCalls = 0;
  const contentAgentExecutor = {
    version: 1,
    kind: 'DynamicFormalContentFixtureExecutor',
    executorId: 'dynamic-formal-content-fixture',
    capabilities: () => buildExecutorCapabilities({
      executorId: 'dynamic-formal-content-fixture',
      sandboxModes: ['read-only'],
      networkPolicy: 'none',
      receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute(input) {
      contentAgentCalls += 1;
      assert.equal(input.role, 'research-content-producer');
      assert.equal(input.sandbox, 'read-only');
      assert.match(input.instructions, /leanTypeSource must be a bounded Lean 4 theorem type only/);
      const receiptPayload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        status: 'agent_execution_completed',
        agentId: 'dynamic-content-author',
        providerMode: 'fixture-agent',
        resolvedModel: 'dynamic-content-v1',
        promptHash: digest('content-prompt'),
        changedPaths: [],
        structuredOutput: {
          status: 'completed',
          summary: 'Generated a bounded empirical hypothesis and a dynamic Lean induction claim.',
          checksRun: ['schema', 'formal-scope'],
          blockers: [],
          empiricalHypothesis: {
            statement: 'The declared treatment improves bounded score relative to the control.',
            assumptions: ['The registered benchmark cases are available.'],
            quantifiers: ['For every registered deterministic seed.'],
            negativeBoundaries: ['No open-world or causal claim is made.'],
            empiricalObligations: ['Execute treatment, control, and ablation with fixed metrics.'],
          },
          dynamicFormalClaim: {
            statement: 'Adding a natural number to zero on the left returns that number.',
            assumptions: ['The quantified value has type Nat.', 'Natural-number addition follows its inductive definition.'],
            quantifiers: ['For every natural number n.'],
            negativeBoundaries: ['No empirical conclusion follows from the arithmetic identity.'],
            proofObligations: ['Kernel replay verifies the induction base and successor step for the exact bound Lean type without axioms.'],
            leanDeclarationName: 'generatedZeroAdd',
            leanTypeSource: '∀ n : Nat, 0 + n = n',
            allowedImports: ['Init'],
          },
        },
      };
      return Object.freeze({
        ...receiptPayload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', receiptPayload),
      });
    },
  };
  const contentProducer = createAgentResearchContentProducer({
    agentExecutor: contentAgentExecutor,
    workspacePath: workspace,
    cacheRoot,
    producerId: 'dynamic-content-author',
    allowedProtocolFamilies: [protocolFamily],
    dynamicFormalClaimsEnabled: true,
    capabilityScopeManifestHash:
      capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    clock: { now: () => new Date(FIXED_TIME) },
  });
  const prepared = await prepareAutonomousResearchLoop({
    paperId,
    objective,
    protocolFamily,
    hypothesisGenerator: contentProducer,
    declaredCapabilityScopeManifest: capabilityScopeManifest,
    createdAt: FIXED_TIME,
  });
  const seed = prepared.dynamicFormalClaimSeed;
  assert.equal(contentAgentCalls, 1);
  assert.equal(verifyDynamicFormalClaimSeed(seed).valid, true);
  assert.equal(prepared.proposal.formalSupportMode, 'dynamic-lean-type-v1');
  assert.equal(prepared.seedBundle.dynamicFormalClaimSeedHash, seed.dynamicFormalClaimSeedHash);
  fs.writeFileSync(
    path.join(workspace, prepared.seedBinding.contractPath),
    `${JSON.stringify(prepared.seedBundle, null, 2)}\n`,
  );

  const formalSeedClaim = prepared.seedBundle.claims.find((claim) => (
    claim.verificationMode === 'formal_kernel'
  ));
  assert.ok(formalSeedClaim);
  const manuscript = [
    '\\documentclass{article}',
    '\\usepackage{amsthm}',
    '\\newtheorem{theorem}{Theorem}',
    '\\begin{document}',
    `\\begin{theorem}${formalSeedClaim.text}\\end{theorem}`,
    '\\begin{proof}By induction on $n$: the zero case is definitional, and the successor case follows by applying $\\operatorname{succ}$ to the induction hypothesis.\\end{proof}',
    '\\end{document}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(workspace, 'main.tex'), manuscript);
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), `${JSON.stringify({
    version: 1,
    kind: 'TheoremSpecificationDraft',
    claims: [{
      claimKey: formalSeedClaim.scientificClaimKey,
      title: 'Generated zero-addition identity',
      statement: formalSeedClaim.text,
      assumptions: formalSeedClaim.assumptions,
      quantifiers: formalSeedClaim.quantifiers,
      negativeBoundaries: formalSeedClaim.negativeBoundaries,
      proofObligations: formalSeedClaim.proofObligations,
      evidenceObligations: [],
      manuscriptIntent: 'existing',
      proposalClaimId: formalSeedClaim.id,
    }],
  }, null, 2)}\n`);
  const finalization = finalizeTheoremSpecification({
    workspace,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    scientificClaimAuthority: prepared.seedBinding,
  });
  const specification = readFinalizedTheoremSpecification({
    workspace,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    scientificClaimAuthority: prepared.seedBinding,
  });
  const specificationClaim = specification.claims[0];
  assert.equal(finalization.theoremSpecificationHash, specification.theoremSpecificationHash);
  assert.equal(
    specificationClaim.proposalClaimSource.dynamicFormalClaimSeedHash,
    seed.dynamicFormalClaimSeedHash,
  );
  assert.deepEqual(specificationClaim.proofObligationContracts.map((item) => item.displayText),
    seed.proofObligations);

  const leanSource = [
    'import Init',
    `theorem ${seed.leanDeclarationName} : ${seed.leanTypeSource} := by`,
    '  intro n',
    '  induction n with',
    '  | zero => rfl',
    '  | succ n inductionHypothesis =>',
    '    change Nat.succ (0 + n) = Nat.succ n',
    '    exact congrArg Nat.succ inductionHypothesis',
    '',
  ].join('\n');
  const declaration = leanSourceDeclarationRecords(leanSource)
    .find((item) => item.name === seed.leanDeclarationName);
  assert.ok(declaration);
  assert.equal(declaration.typeHash, seed.leanNormalizedTypeHash);
  fs.writeFileSync(path.join(workspace, 'lakefile.lean'), [
    'import Lake',
    'open Lake DSL',
    'package heptaDynamicFormalKernel where',
    '@[default_target]',
    'lean_lib Main where',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'lean-toolchain'), `${preflight.runtime.toolchain}\n`);
  fs.writeFileSync(path.join(workspace, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.1.0',
    packagesDir: '.lake/packages',
    packages: [],
    name: 'heptaDynamicFormalKernel',
    lakeDir: '.lake',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workspace, 'Main.lean'), leanSource);
  const sourceHash = hashBytes(Buffer.from(leanSource));
  const proofObligationMappings = specificationClaim.proofObligationContracts.map((obligation) => ({
    ...obligation,
    leanDeclarations: [seed.leanDeclarationName],
  }));
  const rawBinding = {
    claimId: specificationClaim.claimId,
    theoremSpecificationHash: specification.theoremSpecificationHash,
    theoremSpecificationClaimHash: specificationClaim.theoremSpecificationClaimHash,
    theoremName: seed.leanDeclarationName,
    sourceFile: 'Main.lean',
    expectedTypeHash: seed.leanNormalizedTypeHash,
    sourceStatementHash: declaration.statementHash,
    proofObligations: specificationClaim.proofObligations,
    proofObligationContracts: specificationClaim.proofObligationContracts,
    proofObligationMappings,
    manuscriptSource: {
      path: specificationClaim.manuscriptSource.path,
      byteStart: specificationClaim.manuscriptSource.byteStart,
      byteEnd: specificationClaim.manuscriptSource.byteEnd,
      contentHash: specificationClaim.manuscriptSource.contentHash,
    },
  };
  const worker = {
    id: 'dynamic-lean-proof',
    type: 'formal_verifier_lake',
    evidenceClass: 'research_evidence',
    syntheticInput: false,
    outcomesPreprogrammed: false,
    claimIds: [specificationClaim.claimId],
    inputs: [{ role: 'formal_source', path: 'Main.lean', sha256: sourceHash }],
    parameters: {
      projectRoot: '.',
      executable: 'lake',
      timeoutMs: 120_000,
      claimBindings: [rawBinding],
    },
  };
  const plan = {
    version: 1,
    kind: 'NativeResearchWorkerPlan',
    paperId,
    taskKey: `paper_factory:${paperId}`,
    workers: [worker],
  };
  const planPath = path.join(workspace, 'RESEARCH_WORKER_PLAN.json');
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const workerPlanHash = hashBytes(fs.readFileSync(planPath));
  const canonicalClaimRegistry = canonicalClaimsFromWorkerPlan({
    sourceRoot: workspace,
    paperTask: { sourceWorkspace: workspace, mainTex: path.join(workspace, 'main.tex') },
    plan,
  });
  assert.equal(canonicalClaimRegistry.status, 'canonical_claim_registry_verified',
    canonicalClaimRegistry.blockers.join(','));
  const canonicalClaim = canonicalClaimRegistry.byClaimId.get(specificationClaim.claimId);
  assert.ok(canonicalClaim);

  const authorReceipt = formalAgentReceipt({
    agentId: 'dynamic-formal-author',
    role: 'formal-author',
    changedPaths: [
      'Main.lean', 'RESEARCH_WORKER_PLAN.json', 'lake-manifest.json', 'lakefile.lean',
      'lean-toolchain',
    ],
  });
  const proposalSource = specificationClaim.proposalClaimSource;
  const reviewReceipt = formalAgentReceipt({
    agentId: 'dynamic-formal-reviewer',
    role: 'formal-review',
    structuredOutput: {
      version: 2,
      kind: 'FormalClaimSemanticReview',
      theoremSpecificationHash: specification.theoremSpecificationHash,
      reviews: [{
        claimId: specificationClaim.claimId,
        theoremName: seed.leanDeclarationName,
        manuscriptClaimHash: canonicalClaim.manuscriptClaimHash,
        theoremTypeHash: seed.leanNormalizedTypeHash,
        sourceStatementHash: declaration.statementHash,
        status: 'formal_semantic_review_verified',
        semanticEquivalenceVerified: true,
        verdict: 'equivalent',
        proposalClaimId: proposalSource.proposalClaimId,
        proposalClaimRecordHash: proposalSource.proposalClaimRecordHash,
        proposalClaimTextHash: proposalSource.proposalClaimTextHash,
        proposalToTheoremSemanticVerified: true,
        proposalToTheoremVerdict: 'equivalent',
        approvedNarrowingRationale: null,
      }],
    },
  });
  const campaign = {
    campaignId,
    paperId,
    spec: { scientificClaimAuthority: prepared.seedBinding },
  };
  const reviewNode = { nodeId: 'dynamic-formal-review-node', attemptId: 'review-attempt-1' };
  const authorNode = {
    nodeId: 'dynamic-formal-author-node',
    attemptId: 'author-attempt-1',
    result: authorReceipt,
  };
  const reviewEnvelope = buildCampaignFormalReviewEnvelope({
    campaign,
    node: reviewNode,
    authorNode,
    receipt: reviewReceipt,
    workspace,
    manuscript: 'main.tex',
  });
  assert.equal(reviewEnvelope.status, 'formal_semantic_review_envelope_verified',
    reviewEnvelope.blockers.join(','));
  assert.equal(
    reviewEnvelope.proposalClaimToTheoremBinding.entries[0].theoremSpecificationClaimHash,
    specificationClaim.theoremSpecificationClaimHash,
  );

  const bound = bindFormalReviewsToWorkers({
    workers: plan.workers,
    formalReviewEnvelope: reviewEnvelope,
    theoremSpecification: specification,
    paperId,
    canonicalClaimRegistry,
    workerPlanHash,
  });
  assert.deepEqual(bound.blockers, []);
  const boundWorker = bound.workers[0];
  const boundClaim = boundWorker.parameters.claimBindings[0];
  assert.equal(boundClaim.dynamicFormalClaimSeedHash, seed.dynamicFormalClaimSeedHash);
  assert.equal(boundClaim.proposalClaimToTheoremBindingHash,
    reviewEnvelope.proposalClaimToTheoremBindingHash);
  assert.equal(verifyFormalClaimContract(boundClaim.formalClaimContract, {
    claimId: specificationClaim.claimId,
    theoremName: seed.leanDeclarationName,
    theoremTypeHash: seed.leanNormalizedTypeHash,
    theoremSpecificationHash: specification.theoremSpecificationHash,
    theoremSpecificationClaimHash: specificationClaim.theoremSpecificationClaimHash,
    proofObligations: specificationClaim.proofObligations,
    proofObligationContracts: specificationClaim.proofObligationContracts,
    proofObligationMappings,
  }).valid, true);

  const kernelResult = await executeLakeFormalWorker({
    worker: boundWorker,
    inputRecords: [{
      absolutePath: path.join(workspace, 'Main.lean'),
      hash: sourceHash,
    }],
    sourceRoot: workspace,
    trustedSandboxRuntime: preflight.formalSandboxRuntime,
  });
  assert.equal(kernelResult.status, 'formal_claim_verified',
    JSON.stringify(kernelResult, null, 2));
  assert.deepEqual(kernelResult.blockers, []);
  assert.equal(kernelResult.toolchainRuntimeIdentity.status, 'lean_toolchain_identity_verified');
  assert.equal(kernelResult.claimBindingReport.status, 'formal_claim_binding_verified');
  assert.equal(kernelResult.claimBindingReport.bindings[0].valid, true);
  assert.equal(kernelResult.claimBindings[0].dynamicFormalClaimSeedHash,
    seed.dynamicFormalClaimSeedHash);
  const exactTypeAuditSource = [
    '-- Main.lean',
    `#check (${seed.leanDeclarationName} : ${seed.leanTypeSource})`,
    `#print axioms ${seed.leanDeclarationName}`,
    `#eval IO.println "HEPTA_READABLE_PROOF_BEGIN:${seed.leanDeclarationName}"`,
    `set_option pp.explicit true in #print ${seed.leanDeclarationName}`,
    `#eval IO.println "HEPTA_READABLE_PROOF_END:${seed.leanDeclarationName}"`,
  ].join('\n');
  assert.equal(kernelResult.systemAuditHash,
    hashBytes(Buffer.from(exactTypeAuditSource)));
  assert.equal(kernelResult.replayReceipt.status, 'formal_claim_replay_verified',
    JSON.stringify(kernelResult.replayReceipt, null, 2));
  assert.equal(kernelResult.replayReceipt.originalCertificateBundleHash,
    kernelResult.certificateBundleHash);
  assert.match(kernelResult.replayReceipt.rerunCertificateBundleHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(kernelResult.replayReceipt.systemAuditHash, kernelResult.systemAuditHash);
  assert.match(kernelResult.formalCertificateReplayReceiptHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(kernelResult.productionReadableProofReady, true);
  assert.equal(kernelResult.productionReadableProofExplanationReady, true);
  assert.equal(independentlyVerifyFormalReadableProofWorkerResult(kernelResult, {
    required: true,
  }).valid, true);
  const readableProof = kernelResult.readableProofExplanationBundle.explanations[0];
  assert.equal(readableProof.theoremName, seed.leanDeclarationName);
  assert.equal(readableProof.theoremTypeHash, seed.leanNormalizedTypeHash);
  assert.equal(readableProof.nodes.some((item) => item.kind === 'formal_goal'), true);
  assert.equal(readableProof.nodes.some((item) => item.kind === 'proof_expression'), true);
  assert.equal(readableProof.nodes.some((item) => item.kind === 'kernel_replay_closure'), true);
  assert.match(readableProof.proofPrintText, new RegExp(seed.leanDeclarationName));
  assert.equal(readableProof.naturalLanguageDerivationMachineProven, false);
  assert.equal(fs.existsSync(path.join(workspace, '.lake')), false,
    'initial verification and replay must build only fresh snapshots');

  const formalSupportAuthority = buildAutonomousFormalSupportSurfaceAuthority({
    proposal: prepared.proposal,
    seedBundle: prepared.seedBundle,
    formalVerificationReceipt: {
      status: 'campaign_formal_verification_completed',
      blockers: [],
      nativeResearchWorkerExecution: {
        workerReceipts: [{ workerType: 'formal_verifier_lake', result: kernelResult }],
      },
    },
  });
  assert.equal(verifyAutonomousFormalSupportSurfaceAuthority(formalSupportAuthority), true);
  assert.equal(formalSupportAuthority.kernelCertificateBundleHash,
    kernelResult.certificateBundleHash);
  assert.equal(formalSupportAuthority.kernelReplayReceiptHash,
    kernelResult.formalCertificateReplayReceiptHash);
  assert.equal(formalSupportAuthority.version, 3);
  assert.equal(formalSupportAuthority.productionReadableProofReady, true);
  assert.equal(formalSupportAuthority.readableProofExplanationHash,
    readableProof.formalReadableProofExplanationHash);
  assert.equal(formalSupportAuthority.proofBody.includes(
    kernelResult.certificateBundleHash,
  ), false);
  assert.equal(formalSupportAuthority.proofBody.includes(
    kernelResult.formalCertificateReplayReceiptHash,
  ), false);
  assert.match(formalSupportAuthority.proofBody,
    /Kernel-elaborated declaration projection/);

  const replayPayload = { ...kernelResult.replayReceipt };
  delete replayPayload.formalCertificateReplayReceiptHash;
  assert.equal(kernelResult.replayReceipt.formalCertificateReplayReceiptHash,
    hashRecord('FormalCertificateReplayReceipt', replayPayload));
  assert.equal(reviewEnvelope.formalSemanticReviewEnvelopeHash,
    hashPaperRecord('FormalClaimSemanticReviewEnvelope', (() => {
      const { formalSemanticReviewEnvelopeHash: _hash, ...payload } = reviewEnvelope;
      return payload;
    })()));
});
