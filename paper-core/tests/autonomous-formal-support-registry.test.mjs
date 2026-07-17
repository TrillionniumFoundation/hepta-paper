import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createLakeFormalVerifier } from '../../paper-adapters/research-verify/lake-formal-verifier.mjs';
import { leanSourceDeclarationRecords } from '../../paper-adapters/research-verify/lean-source-contracts.mjs';
import {
  AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY,
  autonomousFormalLeanTypeContractForObligation,
  autonomousFormalSupportMarkerDeclaration,
  autonomousFormalSupportMarkerDeclarationValid,
  autonomousFormalSupportSurfaceBody,
  autonomousFormalTypeAuditForObligation,
  buildAutonomousFormalSupportSurfaceAuthority,
  selectAutonomousFormalSupportTemplate,
  verifyAutonomousFormalSupportSurfaceAuthority,
  verifyAutonomousFormalSupportTemplate,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import {
  buildDeterministicAutonomousHypothesisDraft,
  createAutonomousHypothesisGenerationReceipt,
  createMachineProposedScientificClaimSet,
  selectDeterministicAutonomousResearchAgenda,
  verifyMachineProposedScientificClaimSet,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  buildAutonomousResearchSeedBinding,
  buildAutonomousResearchSeedContractBundle,
  evaluateAutonomousResearchPolicy,
  verifyAutonomousResearchPolicyAuthorization,
} from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import { buildFormalClaimContract } from '../../paper-domain/research/formal-claim-contract.mjs';
import {
  verifyScientificClaimLineageAuthority,
} from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const FAMILIES = Object.freeze([
  'econometrics_panel_benchmark',
  'finance_asset_pricing_benchmark',
  'ml_algorithm_benchmark',
  'operations_optimization_benchmark',
  'rl_stochastic_control_benchmark',
]);

const LEAN_PROOFS = Object.freeze({
  econometrics_panel_benchmark: [
    'by',
    '  intro scheduledCells retainedCells h',
    '  induction retainedCells generalizing scheduledCells with',
    '  | zero => exact Nat.add_zero scheduledCells',
    '  | succ retainedCells ih =>',
    '    cases scheduledCells with',
    '    | zero => exact False.elim (Nat.not_succ_le_zero retainedCells h)',
    '    | succ scheduledCells =>',
    '      rw [Nat.succ_sub_succ_eq_sub]',
    '      rw [Nat.add_succ]',
    '      exact congrArg Nat.succ (ih scheduledCells (Nat.le_of_succ_le_succ h))',
  ].join('\n'),
  finance_asset_pricing_benchmark: [
    'by',
    '  intro loss cap',
    '  rw [Nat.min_eq_min]',
    '  rw [Nat.min_def]',
    '  split',
    '  case isTrue h => exact h',
    '  case isFalse h => exact Nat.le_refl cap',
  ].join('\n'),
  ml_algorithm_benchmark: [
    'by',
    '  intro α schedule accept',
    '  induction schedule with',
    '  | nil => exact Nat.le_refl 0',
    '  | cons head tail ih =>',
    '    cases h : accept head with',
    '    | false =>',
    '      rw [List.filter]',
    '      rw [h]',
    '      exact Nat.le_succ_of_le ih',
    '    | true =>',
    '      rw [List.filter]',
    '      rw [h]',
    '      exact Nat.succ_le_succ ih',
  ].join('\n'),
  operations_optimization_benchmark: [
    'by',
    '  intro demand capacity',
    '  rw [Nat.min_eq_min]',
    '  rw [Nat.min_def]',
    '  split',
    '  case isTrue h => exact ⟨Nat.le_refl demand, h⟩',
    '  case isFalse h =>',
    '    exact ⟨Nat.le_of_lt (Nat.lt_of_not_ge h), Nat.le_refl capacity⟩',
  ].join('\n'),
  rl_stochastic_control_benchmark: [
    'by',
    '  intro α trajectory horizon',
    '  induction horizon generalizing trajectory with',
    '  | zero => exact Nat.zero_le trajectory.length',
    '  | succ horizon ih =>',
    '    cases trajectory with',
    '    | nil => exact Nat.le_refl 0',
    '    | cons head tail => exact Nat.succ_le_succ (ih tail)',
  ].join('\n'),
});

function researchPipeline(protocolFamily, suffix = protocolFamily) {
  const paperId = `formal-registry-${suffix}`;
  const objective = `Evaluate the bounded ${protocolFamily} protocol`;
  const agendaSelectionReceipt = selectDeterministicAutonomousResearchAgenda({
    paperId,
    objective,
    protocolFamily,
  });
  const draft = buildDeterministicAutonomousHypothesisDraft({ objective, protocolFamily });
  const generationReceipt = createAutonomousHypothesisGenerationReceipt({ draft });
  const proposal = createMachineProposedScientificClaimSet({
    paperId,
    objective,
    protocolFamily,
    draft,
    generationReceipt,
    agendaSelectionReceipt,
  });
  const policyAuthorization = evaluateAutonomousResearchPolicy({ proposal });
  const seedBundle = buildAutonomousResearchSeedContractBundle({
    proposal,
    policyAuthorization,
  });
  const seedBinding = buildAutonomousResearchSeedBinding({ seedBundle });
  return {
    paperId,
    draft,
    proposal,
    policyAuthorization,
    seedBundle,
    seedBinding,
  };
}

function rehashProposal(value) {
  const proposal = structuredClone(value);
  const receiptPayload = { ...proposal.generationReceipt };
  delete receiptPayload.autonomousHypothesisGenerationReceiptHash;
  receiptPayload.outputHash = hashRecord(
    'AutonomousResearchHypothesisDraft',
    proposal.sourceDraft,
  );
  proposal.generationReceipt = {
    ...receiptPayload,
    autonomousHypothesisGenerationReceiptHash:
      hashRecord('AutonomousHypothesisGenerationReceipt', receiptPayload),
  };
  proposal.generationReceiptHash =
    proposal.generationReceipt.autonomousHypothesisGenerationReceiptHash;
  const payload = { ...proposal };
  delete payload.machineProposedScientificClaimSetHash;
  return {
    ...payload,
    machineProposedScientificClaimSetHash:
      hashRecord('MachineProposedScientificClaimSet', payload),
  };
}

function rehashSeedBundle(value) {
  const payload = structuredClone(value);
  delete payload.autonomousResearchSeedContractBundleHash;
  return {
    ...payload,
    autonomousResearchSeedContractBundleHash:
      hashRecord('AutonomousResearchSeedContractBundle', payload),
  };
}

test('all five protocol families bind one distinct formal template through proposal, policy, seed, lineage, and manuscript surface', () => {
  assert.deepEqual(AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY.protocolFamilies, FAMILIES);
  const templateIds = new Set();
  const templateHashes = new Set();
  for (const protocolFamily of FAMILIES) {
    const template = selectAutonomousFormalSupportTemplate(protocolFamily);
    const pipeline = researchPipeline(protocolFamily);
    templateIds.add(template.templateId);
    templateHashes.add(template.autonomousFormalSupportTemplateHash);
    assert.equal(verifyAutonomousFormalSupportTemplate(template, { protocolFamily }), true);
    assert.deepEqual(pipeline.draft.formalSupportClaim, template.scope);
    assert.equal(
      verifyMachineProposedScientificClaimSet(pipeline.proposal).valid,
      true,
    );
    assert.equal(
      verifyAutonomousResearchPolicyAuthorization(pipeline.policyAuthorization, {
        proposal: pipeline.proposal,
      }).valid,
      true,
    );
    assert.equal(pipeline.seedBundle.status, 'autonomous_research_seed_contracts_ready');
    const lineage = verifyScientificClaimLineageAuthority({
      scientificClaimAuthority: pipeline.seedBinding,
      seedContractBundle: pipeline.seedBundle,
      paperId: pipeline.paperId,
    });
    assert.equal(lineage.valid, true, JSON.stringify(lineage.blockers));
    assert.equal(lineage.claims.length, 1);
    assert.equal(lineage.claims[0].proposalClaimText, template.scope.statement);
    const typeContract = autonomousFormalLeanTypeContractForObligation(
      template.leanTypeContract.proofObligation,
    );
    assert.deepEqual(typeContract, template.leanTypeContract);
    assert.equal(
      template.proofExposition.obligationId,
      template.leanTypeContract.proofObligation,
    );
    assert.equal(
      template.proofExposition.leanDeclaration,
      template.leanTypeContract.canonicalTheoremName,
    );
    assert.equal(template.proofExposition.steps.length >= 2, true);
    assert.equal(
      autonomousFormalTypeAuditForObligation({
        proofObligation: template.leanTypeContract.proofObligation,
        theoremName: template.leanTypeContract.canonicalTheoremName,
      }),
      `#check (${template.leanTypeContract.canonicalTheoremName} : ${template.leanTypeContract.expectedType})`,
    );
    const surfaceAuthority = buildAutonomousFormalSupportSurfaceAuthority({
      proposal: pipeline.proposal,
      seedBundle: pipeline.seedBundle,
    });
    const marker = autonomousFormalSupportMarkerDeclaration(surfaceAuthority);
    assert.equal(verifyAutonomousFormalSupportSurfaceAuthority(surfaceAuthority), true);
    assert.equal(autonomousFormalSupportMarkerDeclarationValid(marker, surfaceAuthority), true);
    assert.match(autonomousFormalSupportSurfaceBody(surfaceAuthority), /\\begin\{theorem\}/);
    assert.match(surfaceAuthority.proofBody, /Bound formal obligation/);
    assert.equal(
      surfaceAuthority.proofBody.includes(
        template.leanTypeContract.proofObligation.replaceAll('_', '\\_'),
      ),
      true,
    );
    assert.equal(
      surfaceAuthority.proofExpositionHash,
      template.proofExposition.autonomousFormalProofExpositionHash,
    );
    const expositionSubstitution = structuredClone(surfaceAuthority);
    expositionSubstitution.proofExpositionHash = hashRecord(
      'AutonomousFormalProofExpositionSubstitution',
      { protocolFamily },
    );
    delete expositionSubstitution.autonomousFormalSupportSurfaceAuthorityHash;
    expositionSubstitution.autonomousFormalSupportSurfaceAuthorityHash = hashRecord(
      'AutonomousFormalSupportSurfaceAuthority',
      expositionSubstitution,
    );
    assert.equal(
      verifyAutonomousFormalSupportSurfaceAuthority(expositionSubstitution),
      false,
    );
  }
  assert.equal(templateIds.size, FAMILIES.length);
  assert.equal(templateHashes.size, FAMILIES.length);
});

test('cross-family replacement and registry, template, proposal, or seed hash tampering fail closed', () => {
  const pipeline = researchPipeline('econometrics_panel_benchmark', 'cross-family');
  const foreign = selectAutonomousFormalSupportTemplate('ml_algorithm_benchmark');
  const crossFamilyDraft = structuredClone(pipeline.proposal);
  crossFamilyDraft.sourceDraft.formalSupportClaim = structuredClone(foreign.scope);
  const formalClaim = crossFamilyDraft.claims.find(
    (claim) => claim.verificationMode === 'formal_kernel',
  );
  Object.assign(formalClaim, structuredClone(foreign.scope));
  crossFamilyDraft.formalSupportTemplateId = foreign.templateId;
  crossFamilyDraft.formalSupportTemplateHash = foreign.autonomousFormalSupportTemplateHash;
  const crossFamily = rehashProposal(crossFamilyDraft);
  const crossVerification = verifyMachineProposedScientificClaimSet(crossFamily);
  assert.equal(crossVerification.valid, false);
  assert.ok(crossVerification.blockers.includes(
    'autonomous_research_machine_claim_formal_template_lineage_invalid',
  ));
  assert.equal(evaluateAutonomousResearchPolicy({ proposal: crossFamily }).status,
    'machine_proposal_policy_blocked');

  for (const field of ['formalSupportRegistryHash', 'formalSupportTemplateHash']) {
    const mutated = structuredClone(pipeline.proposal);
    mutated[field] = hashRecord('AutonomousFormalRegistryAttack', { field });
    const verification = verifyMachineProposedScientificClaimSet(rehashProposal(mutated));
    assert.equal(verification.valid, false, field);
    assert.ok(verification.blockers.includes(
      'autonomous_research_machine_claim_formal_template_lineage_invalid',
    ));
  }

  const foreignSeedDraft = structuredClone(pipeline.seedBundle);
  foreignSeedDraft.formalSupportTemplateId = foreign.templateId;
  foreignSeedDraft.formalSupportTemplateHash = foreign.autonomousFormalSupportTemplateHash;
  const foreignSeed = rehashSeedBundle(foreignSeedDraft);
  const foreignSeedBinding = buildAutonomousResearchSeedBinding({ seedBundle: foreignSeed });
  const foreignSeedLineage = verifyScientificClaimLineageAuthority({
    scientificClaimAuthority: foreignSeedBinding,
    seedContractBundle: foreignSeed,
    paperId: pipeline.paperId,
  });
  assert.equal(foreignSeedLineage.valid, false);
  assert.ok(foreignSeedLineage.blockers.includes(
    'autonomous_theorem_formal_template_lineage_invalid',
  ));

  const forgedProposalHash = hashRecord('ForgedProposalHash', {});
  const hashTamperedProposal = structuredClone(pipeline.proposal);
  hashTamperedProposal.machineProposedScientificClaimSetHash = forgedProposalHash;
  const hashTamperedSeedDraft = structuredClone(pipeline.seedBundle);
  hashTamperedSeedDraft.proposalHash = forgedProposalHash;
  hashTamperedSeedDraft.scientificClaimInputHash = forgedProposalHash;
  for (const claim of hashTamperedSeedDraft.claims) {
    claim.machineProposedScientificClaimSetHash = forgedProposalHash;
  }
  const hashTamperedSeed = rehashSeedBundle(hashTamperedSeedDraft);
  assert.throws(() => buildAutonomousFormalSupportSurfaceAuthority({
    proposal: hashTamperedProposal,
    seedBundle: hashTamperedSeed,
  }), /autonomous_formal_support_surface_authority_invalid/);
});

test('an empirical hypothesis cannot be relabeled or fully rehashed into a formal theorem', () => {
  const pipeline = researchPipeline('finance_asset_pricing_benchmark', 'empirical-smuggling');
  const proposalDraft = structuredClone(pipeline.proposal);
  const empiricalDraft = proposalDraft.sourceDraft.empiricalHypothesis;
  proposalDraft.sourceDraft.formalSupportClaim = {
    statement: empiricalDraft.statement,
    assumptions: empiricalDraft.assumptions,
    quantifiers: empiricalDraft.quantifiers,
    negativeBoundaries: empiricalDraft.negativeBoundaries,
    proofObligations: empiricalDraft.empiricalObligations,
  };
  const formalProposalClaim = proposalDraft.claims.find(
    (claim) => claim.verificationMode === 'formal_kernel',
  );
  Object.assign(formalProposalClaim, proposalDraft.sourceDraft.formalSupportClaim);
  const smuggledProposal = rehashProposal(proposalDraft);
  const proposalVerification = verifyMachineProposedScientificClaimSet(smuggledProposal);
  assert.equal(proposalVerification.valid, false);
  assert.ok(proposalVerification.blockers.includes(
    'autonomous_research_machine_claim_draft_invalid',
  ));

  const seedDraft = structuredClone(pipeline.seedBundle);
  const empiricalSeedClaim = seedDraft.claims.find(
    (claim) => claim.verificationMode === 'empirical_protocol',
  );
  const formalSeedClaim = seedDraft.claims.find(
    (claim) => claim.verificationMode === 'formal_kernel',
  );
  empiricalSeedClaim.verificationMode = 'formal_kernel';
  formalSeedClaim.verificationMode = 'empirical_protocol';
  const smuggledSeed = rehashSeedBundle(seedDraft);
  const smuggledBinding = buildAutonomousResearchSeedBinding({ seedBundle: smuggledSeed });
  const lineage = verifyScientificClaimLineageAuthority({
    scientificClaimAuthority: smuggledBinding,
    seedContractBundle: smuggledSeed,
    paperId: pipeline.paperId,
  });
  assert.equal(lineage.valid, false);
  assert.ok(lineage.blockers.includes('autonomous_theorem_formal_template_lineage_invalid'));
  assert.ok(lineage.blockers.some((blocker) => (
    blocker.includes('autonomous_theorem_formal_claim_status_invalid')
  )));
});

test('all registry-bound proof expositions compile as readable LaTeX surfaces', (t) => {
  const probe = spawnSync('latexmk', ['-version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip(`latexmk unavailable: ${probe.stderr || probe.stdout}`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-exposition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const surfaces = FAMILIES.map((protocolFamily) => {
    const pipeline = researchPipeline(protocolFamily, `latex-${protocolFamily}`);
    const authority = buildAutonomousFormalSupportSurfaceAuthority({
      proposal: pipeline.proposal,
      seedBundle: pipeline.seedBundle,
    });
    return [
      `\\section{${protocolFamily.replaceAll('_', '\\_')}}`,
      autonomousFormalSupportSurfaceBody(authority),
    ].join('\n');
  });
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '\\documentclass{article}',
    '\\usepackage{amsmath,amssymb,amsthm}',
    '\\newtheorem{theorem}{Theorem}',
    '\\begin{document}',
    ...surfaces,
    '\\end{document}',
    '',
  ].join('\n'));
  const compiled = spawnSync('latexmk', [
    '-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  assert.equal(fs.statSync(path.join(root, 'main.pdf')).size > 0, true);
});

function formalBinding(template, declaration) {
  const theoremName = template.leanTypeContract.canonicalTheoremName;
  const claimId = `claim-${template.protocolFamily}`;
  const proofObligations = [template.leanTypeContract.proofObligation];
  const formalClaimContract = buildFormalClaimContract({
    claimId,
    claimText: template.scope.statement,
    sourceLocator: `main.tex#${claimId}`,
    theoremName,
    theoremTypeHash: declaration.typeHash,
    sourceStatementHash: declaration.statementHash,
    proofObligations,
    manuscriptSourceIdentity: {
      path: 'main.tex',
      byteStart: 0,
      byteEnd: 1,
      contentHash: hashRecord('RegistryManuscriptClaimContent', { claimId }),
      fileHash: hashRecord('RegistryManuscriptFile', { claimId }),
    },
    semanticReview: {
      status: 'formal_semantic_review_verified',
      reviewerId: 'registry-independent-reviewer',
      authorId: 'registry-formal-author',
      semanticEquivalenceVerified: true,
      reviewReceiptHash: hashRecord('RegistryFormalReviewReceipt', { claimId }),
      reviewEnvelopeHash: hashRecord('RegistryFormalReviewEnvelope', { claimId }),
      reviewNodeId: `review-${claimId}`,
      reviewAttemptId: `review-attempt-${claimId}`,
      reviewAgentReceiptHash: hashRecord('RegistryReviewAgentReceipt', { claimId }),
      authorNodeId: `author-${claimId}`,
      authorAgentReceiptHash: hashRecord('RegistryAuthorAgentReceipt', { claimId }),
      reviewedManuscriptHash: hashRecord('RegistryReviewedManuscript', { claimId }),
      reviewedWorkerPlanHash: hashRecord('RegistryReviewedWorkerPlan', { claimId }),
    },
  });
  assert.equal(formalClaimContract.status, 'formal_claim_contract_verified');
  return {
    claimId,
    theoremName,
    sourceFile: 'Main.lean',
    expectedTypeHash: declaration.typeHash,
    sourceStatementHash: declaration.statementHash,
    proofObligations,
    manuscriptClaimHash: formalClaimContract.manuscriptClaimHash,
    formalClaimContract,
  };
}

test('Lake exact-type audit compiles all five registry invariants with one check each and no axioms', async (t) => {
  const toolchain = 'leanprover/lean4:v4.30.0';
  const environment = { ...process.env, ELAN_TOOLCHAIN: toolchain };
  const probe = spawnSync('lake', ['--version'], { encoding: 'utf8', env: environment });
  if (probe.status !== 0) {
    t.skip(`Lake unavailable: ${probe.stderr || probe.stdout}`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'lakefile.lean'), [
    'import Lake',
    'open Lake DSL',
    'package heptaFormalRegistry where',
    '@[default_target]',
    'lean_lib Main where',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'lean-toolchain'), `${toolchain}\n`);
  fs.writeFileSync(path.join(root, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.1.0',
    packagesDir: '.lake/packages',
    packages: [],
    name: 'heptaFormalRegistry',
    lakeDir: '.lake',
  }, null, 2)}\n`);
  const templates = FAMILIES.map(selectAutonomousFormalSupportTemplate);
  const source = `${templates.map((template) => [
    `theorem ${template.leanTypeContract.canonicalTheoremName} : ${template.leanTypeContract.expectedType} :=`,
    LEAN_PROOFS[template.protocolFamily],
  ].join('\n')).join('\n\n')}\n`;
  fs.writeFileSync(path.join(root, 'Main.lean'), source);
  const declarations = leanSourceDeclarationRecords(source);
  const bindings = templates.map((template) => formalBinding(
    template,
    declarations.find((item) => item.name === template.leanTypeContract.canonicalTheoremName),
  ));
  let auditedSource = null;
  const commandRunner = {
    run(spec) {
      auditedSource = fs.readFileSync(path.join(spec.cwd, 'Main.lean'), 'utf8');
      const execution = spawnSync(spec.executable, spec.args, {
        cwd: spec.cwd,
        encoding: 'utf8',
        env: { ...environment, ...spec.env },
        timeout: spec.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      const payload = {
        executable: spec.executable,
        args: spec.args,
        status: execution.status,
        stdout: execution.stdout || '',
        stderr: execution.stderr || '',
      };
      return {
        ...payload,
        ok: execution.status === 0,
        receiptHash: hashRecord('RegistryLakeExecutionReceipt', payload),
        blockers: execution.status === 0 ? [] : ['command_failed'],
      };
    },
  };
  const toolchainIdentity = Object.freeze({
    status: 'lean_toolchain_identity_verified',
    toolchain,
    leanToolchainContentIdentityHash: hashRecord('RegistryLeanToolchainIdentity', {}),
    blockers: [],
  });
  const verifier = createLakeFormalVerifier({
    projectRoot: root,
    commandRunner,
    toolchainIdentityProvider: { inspect: () => toolchainIdentity },
  });
  const result = await verifier.verify({ claimBindings: bindings });
  assert.equal(result.status, 'formal_claim_verified', JSON.stringify(result, null, 2));
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.auditTargets, ['Main.lean']);
  assert.ok(auditedSource);
  for (const template of templates) {
    const theoremName = template.leanTypeContract.canonicalTheoremName;
    const directive = autonomousFormalTypeAuditForObligation({
      proofObligation: template.leanTypeContract.proofObligation,
      theoremName,
    });
    assert.equal(auditedSource.split(directive).length - 1, 1, theoremName);
    assert.equal(auditedSource.split('\n').filter((line) => line === `#check ${theoremName}`).length, 0);
    assert.equal(
      auditedSource.split('\n').filter((line) => line === `#print axioms ${theoremName}`).length,
      1,
    );
  }
});
