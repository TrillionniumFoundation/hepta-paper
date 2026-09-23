import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { executeCampaignFormalVerificationNode } from '../../paper-application/automation/campaign-formal-verification-node-orchestrator.mjs';
import { finalizeCampaignFormalWorkerPlan } from '../../paper-adapters/automation/campaign-formal-worker-plan-finalizer.mjs';
import { finalizeTheoremSpecification } from '../../paper-adapters/automation/theorem-specification-finalizer.mjs';
import { formalAcademicPromotionBlockers } from '../../paper-adapters/research-verify/formal-academic-promotion-policy.mjs';
import { leanSourceDeclarationRecords } from '../../paper-adapters/research-verify/lean-source-contracts.mjs';
import { resolvePinnedLakeExecutable } from '../../paper-adapters/research-verify/pinned-lake-executable-resolver.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import {
  buildCampaignResearchVerificationInput,
} from '../../paper-domain/automation/campaign-research-contract.mjs';
import {
  selectAutonomousFormalSupportTemplate,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import { manuscriptClaimHash } from '../../paper-domain/research/formal-claim-contract.mjs';
import { createTheoremSpecification } from '../../paper-domain/research/theorem-specification.mjs';
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

function registryBoundTheoremSpecification(template, {
  claimKey = 'registry-bound-claim',
} = {}) {
  const claimAuthorityBindingHash = `sha256:${'a'.repeat(64)}`;
  const claimAuthorityBundleHash = `sha256:${'b'.repeat(64)}`;
  const proposalClaimTextHash = hashBytes(Buffer.from(template.scope.statement, 'utf8'));
  return createTheoremSpecification({
    paperId: 'paper-registry',
    campaignId: 'campaign-registry',
    sourceManuscriptPath: 'main.tex',
    sourceManuscriptHash: `sha256:${'c'.repeat(64)}`,
    formalClaimUniverseHash: `sha256:${'d'.repeat(64)}`,
    claimAuthorityType: 'machine-policy-authorized',
    claimAuthorityBindingHash,
    claimAuthorityBundleHash,
    claims: [{
      claimKey,
      title: 'Registry-bound theorem',
      statement: template.scope.statement,
      assumptions: template.scope.assumptions,
      quantifiers: template.scope.quantifiers,
      negativeBoundaries: template.scope.negativeBoundaries,
      proofObligations: template.scope.proofObligations,
      proofDependencyClaimKeys: [],
      evidenceObligations: [],
      manuscriptIntent: 'existing',
      manuscriptSource: {
        path: 'main.tex',
        byteStart: 0,
        byteEnd: Buffer.byteLength(template.scope.statement, 'utf8'),
        contentHash: proposalClaimTextHash,
        formalClaimUniverseEntryHash: `sha256:${'e'.repeat(64)}`,
      },
      proposalClaimSource: {
        claimAuthorityType: 'machine-policy-authorized',
        claimAuthorityBindingHash,
        claimAuthorityBundleHash,
        proposalClaimId: 'proposal-claim-registry',
        proposalClaimText: template.scope.statement,
        scientificClaimKey: claimKey,
        assumptions: template.scope.assumptions,
        quantifiers: template.scope.quantifiers,
        negativeBoundaries: template.scope.negativeBoundaries,
        proofObligations: template.scope.proofObligations,
        proposalClaimTextHash,
        proposalClaimRecordHash: `sha256:${'f'.repeat(64)}`,
      },
    }],
  });
}

function genericTheoremSpecificationForRegistryScope(template) {
  return createTheoremSpecification({
    paperId: 'paper-generic-registry-scope',
    campaignId: 'campaign-generic-registry-scope',
    sourceManuscriptPath: 'main.tex',
    sourceManuscriptHash: `sha256:${'1'.repeat(64)}`,
    formalClaimUniverseHash: `sha256:${'2'.repeat(64)}`,
    claims: [{
      claimKey: 'generic-registry-scope',
      title: 'Generic theorem with registry-shaped scope',
      statement: template.scope.statement,
      assumptions: template.scope.assumptions,
      quantifiers: template.scope.quantifiers,
      negativeBoundaries: template.scope.negativeBoundaries,
      proofObligations: template.scope.proofObligations,
      proofDependencyClaimKeys: [],
      evidenceObligations: [],
      manuscriptIntent: 'existing',
      manuscriptSource: {
        path: 'main.tex',
        byteStart: 0,
        byteEnd: Buffer.byteLength(template.scope.statement, 'utf8'),
        contentHash: hashBytes(Buffer.from(template.scope.statement, 'utf8')),
        formalClaimUniverseEntryHash: `sha256:${'3'.repeat(64)}`,
      },
    }],
  });
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
  assert.equal(
    binding.formalizationMode,
    'semantic_review_only_no_independent_exact_type_authority',
  );
  assert.equal(binding.machineClosedLoopPromotionAllowed, false);
  assert.equal(
    binding.formalTypeAuthority.authorityKind,
    'semantic_review_only_author_declaration',
  );
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
  assert.equal(
    fs.readFileSync(path.join(workspace, 'lakefile.lean'), 'utf8'),
    [
      'import Lake',
      'open Lake DSL',
      'package heptaCampaignFormal where',
      '',
      '@[default_target]',
      'lean_lib HeptaCampaignFormal where',
      '  roots := #[`FormalProof]',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(workspace, 'lake-manifest.json'), 'utf8')),
    {
      version: '1.1.0', packagesDir: '.lake/packages', packages: [],
      name: 'heptaCampaignFormal', lakeDir: '.lake',
    },
  );

  const existingLakefile = [
    'import Lake', 'open Lake DSL', 'package operatorBoundFormal where',
    '@[default_target]', 'lean_lib FormalProof where', '',
  ].join('\n');
  const existingManifest = {
    version: '1.1.0', packagesDir: '.lake/packages', packages: [],
    name: 'operatorBoundFormal', lakeDir: '.lake',
  };
  fs.writeFileSync(path.join(workspace, 'lakefile.lean'), existingLakefile);
  fs.writeFileSync(
    path.join(workspace, 'lake-manifest.json'),
    `${JSON.stringify(existingManifest, null, 2)}\n`,
  );
  finalizeCampaignFormalWorkerPlan({
    workspace,
    paperId: 'paper',
    taskKey: 'paper_factory:paper',
    theoremSpecification,
  });
  assert.equal(
    fs.readFileSync(path.join(workspace, 'lakefile.lean'), 'utf8'),
    [
      'import Lake',
      'open Lake DSL',
      'package heptaCampaignFormal where',
      '',
      '@[default_target]',
      'lean_lib HeptaCampaignFormal where',
      '  roots := #[`FormalProof]',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(workspace, 'lake-manifest.json'), 'utf8')),
    {
      version: '1.1.0', packagesDir: '.lake/packages', packages: [],
      name: 'heptaCampaignFormal', lakeDir: '.lake',
    },
  );
});

test('system finalization rejects an extra helper declaration for a dynamic claim', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dynamic-formal-worker-plan-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = [
    'theorem dynamic_target : True := by trivial',
    'theorem unauthorized_helper : True := by trivial',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(workspace, 'Dynamic.lean'), source);
  const target = leanSourceDeclarationRecords(source)
    .find((declaration) => declaration.name === 'dynamic_target');
  const theoremSpecification = Object.freeze({
    theoremSpecificationHash: `sha256:${'1'.repeat(64)}`,
    claims: Object.freeze([Object.freeze({
      claimId: 'theorem:dynamic-target',
      statement: 'True.',
      theoremSpecificationClaimHash: `sha256:${'2'.repeat(64)}`,
      proposalClaimSource: Object.freeze({
        dynamicFormalClaimSeedHash: `sha256:${'3'.repeat(64)}`,
        leanDeclarationName: 'dynamic_target',
        leanNormalizedTypeHash: target.typeHash,
      }),
      proofObligations: Object.freeze(['prove True']),
      proofObligationContracts: Object.freeze([]),
      manuscriptSource: Object.freeze({
        path: 'main.tex', byteStart: 0, byteEnd: 5,
        contentHash: `sha256:${'4'.repeat(64)}`,
      }),
    })]),
  });
  assert.throws(() => finalizeCampaignFormalWorkerPlan({
    workspace,
    paperId: 'paper',
    taskKey: 'paper_factory:paper',
    theoremSpecification,
  }), /formal_worker_plan_declaration_count_mismatch/);
  assert.equal(fs.existsSync(path.join(workspace, 'RESEARCH_WORKER_PLAN.json')), false);
});

test('system finalization accepts exactly one declaration for one dynamic claim', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dynamic-formal-worker-plan-single-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = 'theorem dynamic_target : True := by trivial\n';
  fs.writeFileSync(path.join(workspace, 'Dynamic.lean'), source);
  const target = leanSourceDeclarationRecords(source)
    .find((declaration) => declaration.name === 'dynamic_target');
  const theoremSpecification = Object.freeze({
    theoremSpecificationHash: `sha256:${'1'.repeat(64)}`,
    claims: Object.freeze([Object.freeze({
      claimId: 'theorem:dynamic-target',
      statement: 'True.',
      theoremSpecificationClaimHash: `sha256:${'2'.repeat(64)}`,
      proposalClaimSource: Object.freeze({
        dynamicFormalClaimSeedHash: `sha256:${'3'.repeat(64)}`,
        leanDeclarationName: 'dynamic_target',
        leanNormalizedTypeHash: target.typeHash,
      }),
      proofObligations: Object.freeze(['prove True']),
      proofObligationContracts: Object.freeze([]),
      manuscriptSource: Object.freeze({
        path: 'main.tex', byteStart: 0, byteEnd: 5,
        contentHash: `sha256:${'4'.repeat(64)}`,
      }),
    })]),
  });
  const result = finalizeCampaignFormalWorkerPlan({
    workspace,
    paperId: 'paper',
    taskKey: 'paper_factory:paper',
    theoremSpecification,
  });
  assert.equal(result.status, 'formal_worker_plan_system_finalized');
  assert.equal(result.plan.workers[0].parameters.claimBindings.length, 1);
  assert.equal(
    result.plan.workers[0].parameters.claimBindings[0].theoremName,
    'dynamic_target',
  );
  assert.equal(
    result.plan.workers[0].parameters.claimBindings[0]
      .formalTypeAuthority.authorityKind,
    'dynamic_typed_seed',
  );
  assert.equal(
    result.plan.workers[0].parameters.claimBindings[0]
      .machineClosedLoopPromotionAllowed,
    true,
  );
});

test('system finalization enforces the exact registry theorem name and type identity', (t) => {
  const template = selectAutonomousFormalSupportTemplate(
    'finance_asset_pricing_benchmark',
  );
  const theoremSpecification = registryBoundTheoremSpecification(template);
  const exactProof = [
    `theorem ${template.leanTypeContract.canonicalTheoremName} : ${template.leanTypeContract.expectedType} := by`,
    '  intro loss cap',
    '  change (if loss ≤ cap then loss else cap) ≤ cap',
    '  split',
    '  · assumption',
    '  · exact Nat.le_refl cap',
    '',
  ].join('\n');

  const accepted = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-registry-formal-exact-'));
  t.after(() => fs.rmSync(accepted, { recursive: true, force: true }));
  fs.writeFileSync(path.join(accepted, 'FormalProof.lean'), exactProof);
  const result = finalizeCampaignFormalWorkerPlan({
    workspace: accepted,
    paperId: theoremSpecification.paperId,
    taskKey: 'paper_factory:paper-registry',
    theoremSpecification,
  });
  assert.equal(
    result.plan.workers[0].parameters.claimBindings[0].theoremName,
    template.leanTypeContract.canonicalTheoremName,
  );
  assert.equal(
    result.plan.workers[0].parameters.claimBindings[0]
      .formalTypeAuthority.authorityKind,
    'system_registry_verified_ir',
  );
  assert.equal(formalAcademicPromotionBlockers(
    result.plan.workers[0],
    {
      status: 'formal_claim_verified',
      replayReceipt: { status: 'formal_claim_replay_verified' },
      formalCertificateReplayReceiptHash:
        hashRecord('RegistryFormalReplayFixture', {}),
    },
  ).some((blocker) => blocker.includes('type_authority')), false);

  const wrongName = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-registry-formal-name-'));
  t.after(() => fs.rmSync(wrongName, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(wrongName, 'FormalProof.lean'),
    exactProof.replace(
      `theorem ${template.leanTypeContract.canonicalTheoremName}`,
      'theorem renamed_loss_cap',
    ),
  );
  assert.throws(() => finalizeCampaignFormalWorkerPlan({
    workspace: wrongName,
    paperId: theoremSpecification.paperId,
    taskKey: 'paper_factory:paper-registry',
    theoremSpecification,
  }), /formal_worker_plan_registry_declaration_name_mismatch/);
  assert.equal(fs.existsSync(path.join(wrongName, 'lakefile.lean')), false);

  const wrongType = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-registry-formal-type-'));
  t.after(() => fs.rmSync(wrongType, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(wrongType, 'FormalProof.lean'),
    `theorem ${template.leanTypeContract.canonicalTheoremName} : True := by trivial\n`,
  );
  assert.throws(() => finalizeCampaignFormalWorkerPlan({
    workspace: wrongType,
    paperId: theoremSpecification.paperId,
    taskKey: 'paper_factory:paper-registry',
    theoremSpecification,
  }), /formal_worker_plan_registry_declaration_type_mismatch/);
  assert.equal(fs.existsSync(path.join(wrongType, 'lakefile.lean')), false);
});

test('system finalization does not classify a generic static claim by registry-shaped prose', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-generic-formal-registry-scope-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const template = selectAutonomousFormalSupportTemplate(
    'finance_asset_pricing_benchmark',
  );
  fs.writeFileSync(path.join(workspace, 'Generic.lean'), [
    `theorem generic_loss_cap : ${template.leanTypeContract.expectedType} := by`,
    '  intro loss cap',
    '  change (if loss ≤ cap then loss else cap) ≤ cap',
    '  split',
    '  · assumption',
    '  · exact Nat.le_refl cap',
    '',
  ].join('\n'));
  const theoremSpecification = genericTheoremSpecificationForRegistryScope(template);
  const result = finalizeCampaignFormalWorkerPlan({
    workspace,
    paperId: theoremSpecification.paperId,
    taskKey: 'paper_factory:paper-generic-registry-scope',
    theoremSpecification,
  });
  assert.equal(
    result.plan.workers[0].parameters.claimBindings[0].theoremName,
    'generic_loss_cap',
  );
  const binding = result.plan.workers[0].parameters.claimBindings[0];
  assert.equal(
    binding.formalizationMode,
    'semantic_review_only_no_independent_exact_type_authority',
  );
  assert.equal(binding.formalTypeAuthority.authoritativeTypeHash, null);
  assert.equal(binding.machineClosedLoopPromotionAllowed, false);
  assert.ok(formalAcademicPromotionBlockers(
    result.plan.workers[0],
    {
      status: 'formal_claim_verified',
      replayReceipt: { status: 'formal_claim_replay_verified' },
      formalCertificateReplayReceiptHash:
        hashRecord('GenericFormalReplayFixture', {}),
    },
  ).includes(
    `${binding.claimId}:formal_semantic_only_machine_closed_loop_promotion_forbidden`,
  ));
});

test('system finalization orders multiple Lean module roots deterministically', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-worker-roots-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'Nested'));
  fs.writeFileSync(
    path.join(workspace, 'Nested', 'Beta.lean'),
    'theorem beta_target : True := by trivial\n',
  );
  fs.writeFileSync(
    path.join(workspace, 'Alpha.lean'),
    'theorem alpha_target : True := by trivial\n',
  );
  const claim = (key, offset) => Object.freeze({
    claimId: `theorem:${key}`,
    statement: 'True.',
    theoremSpecificationClaimHash: `sha256:${String(offset + 1).repeat(64)}`,
    proofObligations: Object.freeze([`prove ${key}`]),
    proofObligationContracts: Object.freeze([]),
    manuscriptSource: Object.freeze({
      path: 'main.tex', byteStart: offset, byteEnd: offset + 5,
      contentHash: `sha256:${String(offset + 3).repeat(64)}`,
    }),
  });
  const result = finalizeCampaignFormalWorkerPlan({
    workspace,
    paperId: 'paper',
    taskKey: 'paper_factory:paper',
    theoremSpecification: Object.freeze({
      theoremSpecificationHash: `sha256:${'a'.repeat(64)}`,
      claims: Object.freeze([claim('alpha', 0), claim('beta', 1)]),
    }),
  });
  assert.deepEqual(
    result.plan.workers[0].inputs.map((input) => input.path),
    ['Alpha.lean', 'Nested/Beta.lean'],
  );
  assert.deepEqual(
    result.plan.workers[0].parameters.claimBindings.map((binding) => binding.theoremName),
    ['alpha_target', 'beta_target'],
  );
  assert.match(
    fs.readFileSync(path.join(workspace, 'lakefile.lean'), 'utf8'),
    /roots := #\[`Alpha, `Nested\.Beta\]/,
  );
});

test('system-finalized multi-root Lake project builds with the pinned runtime', (t) => {
  const environment = {
    ...process.env,
    ELAN_HOME: process.env.ELAN_HOME || '/opt/hepta-paper/elan',
  };
  const pinned = resolvePinnedLakeExecutable({ environment });
  if (pinned.status !== 'formal_pinned_lake_resolved') {
    t.skip(`pinned Lean runtime unavailable: ${pinned.blockers.join(',')}`);
    return;
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-worker-lake-build-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'Nested'));
  fs.writeFileSync(
    path.join(workspace, 'Alpha.lean'),
    'theorem alpha_target : True := by trivial\n',
  );
  fs.writeFileSync(
    path.join(workspace, 'Nested', 'Beta.lean'),
    'theorem beta_target : True := by trivial\n',
  );
  const claim = (key, offset) => Object.freeze({
    claimId: `theorem:${key}`,
    statement: 'True.',
    theoremSpecificationClaimHash: `sha256:${String(offset + 1).repeat(64)}`,
    proofObligations: Object.freeze([`prove ${key}`]),
    proofObligationContracts: Object.freeze([]),
    manuscriptSource: Object.freeze({
      path: 'main.tex', byteStart: offset, byteEnd: offset + 5,
      contentHash: `sha256:${String(offset + 3).repeat(64)}`,
    }),
  });
  finalizeCampaignFormalWorkerPlan({
    workspace,
    paperId: 'paper',
    taskKey: 'paper_factory:paper',
    theoremSpecification: Object.freeze({
      theoremSpecificationHash: `sha256:${'a'.repeat(64)}`,
      claims: Object.freeze([claim('alpha', 0), claim('beta', 1)]),
    }),
  });
  const build = spawnSync(pinned.lakeExecutable, ['build'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...environment,
      ELAN_HOME: pinned.elanHome,
      ELAN_TOOLCHAIN: pinned.toolchain,
    },
  });
  assert.equal(
    build.status,
    0,
    `pinned lake build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );
  assert.equal(
    fs.existsSync(path.join(workspace, '.lake', 'build', 'lib', 'lean', 'Alpha.olean')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(
      workspace, '.lake', 'build', 'lib', 'lean', 'Nested', 'Beta.olean',
    )),
    true,
  );
});

test('system finalization rejects a Lean source without a valid module path', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-worker-bad-module-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(workspace, 'Bad-Module.lean'),
    'theorem target : True := by trivial\n',
  );
  assert.throws(() => finalizeCampaignFormalWorkerPlan({
    workspace,
    paperId: 'paper',
    taskKey: 'paper_factory:paper',
    theoremSpecification: Object.freeze({
      theoremSpecificationHash: `sha256:${'a'.repeat(64)}`,
      claims: Object.freeze([Object.freeze({
        claimId: 'theorem:target',
        statement: 'True.',
        theoremSpecificationClaimHash: `sha256:${'b'.repeat(64)}`,
        proofObligations: Object.freeze(['prove True']),
        proofObligationContracts: Object.freeze([]),
        manuscriptSource: Object.freeze({
          path: 'main.tex', byteStart: 0, byteEnd: 5,
          contentHash: `sha256:${'c'.repeat(64)}`,
        }),
      })]),
    }),
  }), /formal_worker_plan_lean_module_path_invalid/);
  assert.equal(fs.existsSync(path.join(workspace, 'lakefile.lean')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'RESEARCH_WORKER_PLAN.json')), false);
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
    const repairComment = input.role === 'formal-proof-repair' ? `-- repair ${authorCalls}\n` : '';
    const source = `${repairComment}${leanSource}`;
    fs.writeFileSync(path.join(input.workspacePath, 'Main.lean'), source);
    return agentReceipt({
      agentId: 'formal-author', role: input.role,
      changedPaths: ['Main.lean'],
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
      researchVerificationInput: buildCampaignResearchVerificationInput({
        paperId: 'paper',
        paperTask: Object.freeze({
          paperId: 'paper',
          taskKey: 'paper_factory:paper',
          semanticIdentityHash: `sha256:${'5'.repeat(64)}`,
        }),
        paperState: Object.freeze({ evidenceRefs: Object.freeze([]) }),
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

test('formal worker task binding fails before any author or reviewer call', async (t) => {
  const value = fixture(t, { completeAfterIteration: 0 });
  const campaign = Object.freeze({
    ...value.campaign,
    spec: Object.freeze({
      ...value.campaign.spec,
      researchVerificationInput: null,
    }),
  });
  await assert.rejects(
    () => value.executor.execute({
      campaign, node: value.node, allNodes: [],
      deferWorkspaceIntegration: true,
      executionBudget: { remainingTokenCount: 100_000, remainingWallTimeMs: 60_000 },
    }),
    /campaign_formal_verification_blocked:formal_worker_plan_task_binding_missing/,
  );
  assert.deepEqual(value.counts(), { authorCalls: 0, reviewerCalls: 0 });
  assert.equal(fs.readFileSync(path.join(value.workspace, 'Main.lean'), 'utf8'), 'before\n');
});

test('missing formal worker plan finalizer fails before reading the theorem specification', async (t) => {
  const value = fixture(t, { completeAfterIteration: 0 });
  let theoremSpecificationReads = 0;
  await assert.rejects(
    () => executeCampaignFormalVerificationNode({
      primitives: {
        agent: {},
        workspace: {
          readTheoremSpecification() {
            theoremSpecificationReads += 1;
            throw new Error('unexpected_theorem_specification_read');
          },
        },
      },
      campaign: value.campaign,
      node: value.node,
      context: {},
      workspace: value.workspace,
      manuscript: 'main.tex',
    }),
    /campaign_formal_verification_blocked:formal_worker_plan_task_binding_missing/,
  );
  assert.equal(theoremSpecificationReads, 0);
  assert.deepEqual(value.counts(), { authorCalls: 0, reviewerCalls: 0 });
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
  assert.match(value.authorInputs[1].instructions, /exactly one top-level theorem or lemma declaration/);
  assert.match(value.authorInputs[1].instructions, /do not add helper theorem or lemma declarations/);
  assert.doesNotMatch(
    value.authorInputs[1].instructions,
    /Nat\.min|loss_cap_upper_bound|kernel-audited declaration verbatim/,
  );
  assert.match(
    value.authorInputs[1].instructions,
    /host unconditionally rebuilds RESEARCH_WORKER_PLAN\.json/,
  );
  assert.match(
    value.authorInputs[1].instructions,
    /never create or edit those system-owned files/,
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
