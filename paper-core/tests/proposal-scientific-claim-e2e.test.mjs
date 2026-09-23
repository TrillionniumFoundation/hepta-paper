import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { finalizeTheoremSpecification } from '../../paper-adapters/automation/theorem-specification-finalizer.mjs';
import { runPaperProposalAdapter } from '../../paper-adapters/proposal/index.mjs';
import { verifyApprovedFormalProposalWriterSeed } from '../../paper-application/automation/campaign-formal-proposal-writer.mjs';
import { buildCampaignAgentExecutionRequest } from '../../paper-application/automation/campaign-agent-policy.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { createPaperProposalApprovalDocument } from '../../paper-domain/contracts/index.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-15T10:00:00.000Z');
const EXACT_STATEMENT = 'For every natural number $n$, one has $n=n$.';

function temporary(t, prefix = 'hepta-proposal-scientific-e2e-') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(parent, 'assets');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root, runtimeRoot };
}

function scientificClaimDocument(overrides = {}) {
  const claim = {
    claimKey: 'natural-reflexivity',
    statement: EXACT_STATEMENT,
    assumptions: ['The variable $n$ ranges over the natural numbers.'],
    quantifiers: ['For every natural number $n$.'],
    negativeBoundaries: ['No claim about a non-reflexive relation is made.'],
    proofObligations: ['Establish reflexivity of equality for the arbitrary natural number $n$.'],
    ...(overrides.claim || {}),
  };
  return {
    version: 1,
    kind: 'PaperScientificClaimInput',
    claims: [claim],
    ...overrides.document,
  };
}

function writeContext() {
  return {
    artifactRepositoryFactory: () => ({
      async writeJson(target, value) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
        return {};
      },
      async writeText(target, value) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, value);
        return {};
      },
    }),
  };
}

function approvalAuthority(report) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const operatorIdentity = { subjectId: 'scientific-claim-operator', displayName: 'Scientific Claim Operator' };
  const unsigned = createPaperProposalApprovalDocument({
    ideaBrief: report.ideaBrief,
    proposalEnvelope: report.proposalEnvelope,
    generationReceipt: report.generationReceipt,
    operatorIdentity,
    riskAcceptanceRationale: 'The operator approves these exact claim semantics while acknowledging that novelty and correctness remain unverified.',
    signedAt: '2026-07-15T09:00:00.000Z',
    validFrom: '2026-07-15T09:00:00.000Z',
    expiresAt: '2026-07-16T09:00:00.000Z',
  });
  return {
    approvalDocument: signAuthorityDocument(unsigned, {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      keyId: 'scientific-claim-key',
      role: 'proposal_approver',
    }),
    trustStoreOverride: {
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: [{
        keyId: 'scientific-claim-key',
        subjectId: operatorIdentity.subjectId,
        algorithm: 'ed25519',
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
        roles: ['proposal_approver'],
        status: 'active',
      }],
    },
  };
}

function proposalRequest(fixture, scientificClaimDocumentValue = scientificClaimDocument()) {
  return {
    root: fixture.root,
    runtimeRoot: fixture.runtimeRoot,
    paperId: 'exact-scientific-claim',
    idea: 'Prove a fully scoped reflexivity theorem.',
    title: 'A Scoped Reflexivity Theorem',
    discipline: 'mathematics',
    paperType: 'theorem and proof',
    scientificClaimDocument: scientificClaimDocumentValue,
    now: NOW,
  };
}

test('signed exact scientific claims flow from proposal materialization through writer authority into system-finalized theorem spec', async (t) => {
  const fixture = temporary(t);
  const request = proposalRequest(fixture);
  const draft = await runPaperProposalAdapter(request);
  assert.equal(draft.proposalEnvelope.status, 'proposal_draft_ready_for_review');
  assert.equal(draft.proposalEnvelope.proposal.contributionClaims[0], EXACT_STATEMENT);
  assert.equal(draft.proposalEnvelope.safety.noveltyAutomaticallyVerified, false);
  assert.equal(draft.proposalEnvelope.safety.scientificCorrectnessAutomaticallyVerified, false);

  const authority = approvalAuthority(draft);
  const report = await withArtifactWriteContext(writeContext(), () => runPaperProposalAdapter({
    ...request,
    ...authority,
    materializeSource: true,
  }));
  assert.equal(report.materialization.status, 'paper_task_draft_materialized');
  const seed = report.materialization.seedContractBundle;
  assert.equal(seed.claims.length, 1);
  assert.equal(seed.claims[0].text, EXACT_STATEMENT);
  assert.equal(seed.claims[0].scientificClaimKey, 'natural-reflexivity');
  assert.deepEqual(seed.claims[0].assumptions, scientificClaimDocument().claims[0].assumptions);
  assert.equal(seed.scientificClaimInputHash, report.summary.scientificClaimInputHash);
  assert.ok(report.materialization.records.some((record) => record.role === 'scientific_claim_input'));

  const workspace = path.resolve(fixture.root, report.materialization.paperTask.sourceWorkspace);
  const plan = buildPaperCampaignPlan({
    paperId: report.materialization.paperTask.paperId,
    sourceWorkspace: workspace,
    campaignId: 'exact-scientific-claim-campaign',
    mode: 'full-campaign',
    languages: ['lean', 'latex'],
    paperTask: report.materialization.paperTask,
    paperQualityProfile: report.materialization.paperTask.paperQualityProfile,
    paperQualityProfiles: report.materialization.paperTask.paperQualityProfiles,
  });
  const campaign = { campaignId: plan.campaignId, paperId: plan.paperId, spec: plan };
  const writerNode = plan.nodes.find((node) => node.kind === 'writer');
  const seedReceipt = verifyApprovedFormalProposalWriterSeed({
    primitives: {
      workspace: {
        readTextIfPresent: ({ workspace: root, relative }) => {
          try { return fs.readFileSync(path.join(root, relative), 'utf8'); } catch { return null; }
        },
      },
    },
    campaign,
    node: writerNode,
    workspace,
  });
  assert.equal(seedReceipt.status, 'approved_proposal_seed_verified');
  assert.equal(seedReceipt.scientificClaimInputHash, seed.scientificClaimInputHash);
  const executionRequest = buildCampaignAgentExecutionRequest({
    campaign,
    node: writerNode,
    workspace,
    manuscript: 'main.tex',
    reviews: [],
    executionBudget: { remainingTokenCount: 10_000, remainingWallTimeMs: 60_000 },
    executionSignal: null,
  });
  assert.match(executionRequest.instructions, /operator-supplied exact scientific statement/);
  assert.match(executionRequest.instructions, /narrowing, strengthening/);

  fs.writeFileSync(path.join(workspace, 'main.tex'), [
    '\\documentclass{article}',
    '\\usepackage{amsthm}',
    '\\newtheorem{theorem}{Theorem}',
    '\\begin{document}',
    '\\begin{theorem}',
    EXACT_STATEMENT,
    '\\end{theorem}',
    '\\begin{proof}',
    'Equality is reflexive, so the arbitrary natural number equals itself.',
    '\\end{proof}',
    '\\section{Limitations}',
    'No claim about a non-reflexive relation is made.',
    '\\end{document}',
    '',
  ].join('\n'));
  const theoremDraftClaim = {
    claimKey: 'natural-reflexivity',
    title: 'Natural-number equality is reflexive',
    statement: EXACT_STATEMENT,
    assumptions: scientificClaimDocument().claims[0].assumptions,
    quantifiers: scientificClaimDocument().claims[0].quantifiers,
    negativeBoundaries: scientificClaimDocument().claims[0].negativeBoundaries,
    proofObligations: scientificClaimDocument().claims[0].proofObligations,
    evidenceObligations: [],
    manuscriptIntent: 'existing',
    proposalClaimId: seed.claims[0].id,
  };
  for (const field of ['assumptions', 'quantifiers', 'negativeBoundaries', 'proofObligations']) {
    fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), `${JSON.stringify({
      version: 1,
      kind: 'TheoremSpecificationDraft',
      claims: [{ ...theoremDraftClaim, [field]: [`DIFFERENT ${field}`] }],
    }, null, 2)}\n`);
    const canonicalized = finalizeTheoremSpecification({
      workspace,
      manuscriptPath: 'main.tex',
      paperId: plan.paperId,
      campaignId: plan.campaignId,
      approvedProposalSeed: plan.approvedProposalSeed,
    });
    assert.equal(canonicalized.status, 'theorem_specification_finalized');
    const canonical = JSON.parse(fs.readFileSync(path.join(workspace, 'THEOREM_SPEC.json'), 'utf8'));
    assert.deepEqual(canonical.claims[0][field], scientificClaimDocument().claims[0][field]);
    fs.rmSync(path.join(workspace, 'THEOREM_SPEC.json'));
  }
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), `${JSON.stringify({
    version: 1,
    kind: 'TheoremSpecificationDraft',
    claims: [{ ...theoremDraftClaim, claimKey: 'agent-local-key' }],
  }, null, 2)}\n`);
  const remapped = finalizeTheoremSpecification({
    workspace,
    manuscriptPath: 'main.tex',
    paperId: plan.paperId,
    campaignId: plan.campaignId,
    approvedProposalSeed: plan.approvedProposalSeed,
  });
  assert.equal(remapped.status, 'theorem_specification_finalized');
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'THEOREM_SPEC.json'), 'utf8'))
    .claims[0].claimKey, theoremDraftClaim.claimKey);
  fs.rmSync(path.join(workspace, 'THEOREM_SPEC.json'));
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), `${JSON.stringify({
    version: 1,
    kind: 'TheoremSpecificationDraft',
    claims: [theoremDraftClaim],
  }, null, 2)}\n`);
  const finalization = finalizeTheoremSpecification({
    workspace,
    manuscriptPath: 'main.tex',
    paperId: plan.paperId,
    campaignId: plan.campaignId,
    approvedProposalSeed: plan.approvedProposalSeed,
  });
  assert.equal(finalization.status, 'theorem_specification_finalized');
  const specification = JSON.parse(fs.readFileSync(path.join(workspace, 'THEOREM_SPEC.json'), 'utf8'));
  assert.equal(specification.claims[0].statement, EXACT_STATEMENT);
  assert.equal(specification.claims[0].proposalClaimSource.proposalClaimText, EXACT_STATEMENT);
  assert.deepEqual(specification.claims[0].assumptions, scientificClaimDocument().claims[0].assumptions);
  assert.deepEqual(specification.claims[0].proofObligations, scientificClaimDocument().claims[0].proofObligations);
  assert.deepEqual(specification.claims[0].proposalClaimSource.negativeBoundaries,
    scientificClaimDocument().claims[0].negativeBoundaries);
  assert.equal(
    specification.claims[0].proposalClaimSource.proposalClaimRecordHash,
    hashRecord('ApprovedProposalClaimRecord', seed.claims[0]),
  );
});

test('formal deterministic meta-claims and malformed placeholder documents fail closed before materialization', async (t) => {
  const fixture = temporary(t, 'hepta-proposal-scientific-blocked-');
  const withoutScientificClaims = await runPaperProposalAdapter(proposalRequest(fixture, null));
  assert.equal(withoutScientificClaims.proposalEnvelope.status, 'blocked_proposal_draft');
  assert.ok(withoutScientificClaims.proposalEnvelope.blockers.includes('formal_scientific_claim_input_required'));
  assert.match(withoutScientificClaims.proposalEnvelope.proposal.contributionClaims[0], /Define a venue-scoped research question/);

  await assert.rejects(
    () => runPaperProposalAdapter(proposalRequest(fixture, scientificClaimDocument({
      claim: { proofObligations: ['TODO: supply a proof.'] },
    }))),
    /proposal_scientific_claim_proof_obligations_invalid/,
  );
  await assert.rejects(
    () => runPaperProposalAdapter(proposalRequest(fixture, scientificClaimDocument({
      document: { unapprovedExtraField: true },
    }))),
    /proposal_scientific_claim_input_invalid/,
  );
  await assert.rejects(
    () => runPaperProposalAdapter(proposalRequest(fixture, scientificClaimDocument({
      claim: { statement: 'x'.repeat(8_001) },
    }))),
    /proposal_scientific_claim_statement_invalid/,
  );
});

test('approval cannot be replayed after changing scientific scope and a post-materialization seed rewrite is rejected', async (t) => {
  const fixture = temporary(t, 'hepta-proposal-scientific-attack-');
  const request = proposalRequest(fixture);
  const draft = await runPaperProposalAdapter(request);
  const authority = approvalAuthority(draft);
  const approved = await withArtifactWriteContext(writeContext(), () => runPaperProposalAdapter({
    ...request,
    ...authority,
    materializeSource: true,
  }));
  assert.equal(approved.materialization.status, 'paper_task_draft_materialized');
  const seedPath = path.resolve(fixture.root, approved.materialization.seedContractRecord.path);
  const originalSeedBytes = fs.readFileSync(seedPath, 'utf8');

  const changedScope = await withArtifactWriteContext(writeContext(), () => runPaperProposalAdapter({
    ...request,
    scientificClaimDocument: scientificClaimDocument({
      claim: { assumptions: ['The variable $n$ ranges over all integers.'] },
    }),
    ...authority,
    materializeSource: true,
  }));
  assert.equal(changedScope.approvalVerification.status, 'proposal_approval_blocked');
  assert.ok(changedScope.approvalVerification.blockers.includes('proposal_approval_envelope_hash_mismatch'));
  assert.equal(changedScope.materialization.status, 'paper_task_draft_blocked');
  assert.equal(fs.readFileSync(seedPath, 'utf8'), originalSeedBytes);

  const workspace = path.resolve(fixture.root, approved.materialization.paperTask.sourceWorkspace);
  const plan = buildPaperCampaignPlan({
    paperId: approved.materialization.paperTask.paperId,
    sourceWorkspace: workspace,
    campaignId: 'scientific-claim-tamper-campaign',
    mode: 'full-campaign',
    languages: ['lean', 'latex'],
    paperTask: approved.materialization.paperTask,
    paperQualityProfile: approved.materialization.paperTask.paperQualityProfile,
    paperQualityProfiles: approved.materialization.paperTask.paperQualityProfiles,
  });
  const tampered = JSON.parse(originalSeedBytes);
  tampered.claims[0].text = 'For every integer $n$, one has $n=n$.';
  fs.writeFileSync(seedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => verifyApprovedFormalProposalWriterSeed({
    primitives: {
      workspace: {
        readTextIfPresent: ({ workspace: root, relative }) => fs.readFileSync(path.join(root, relative), 'utf8'),
      },
    },
    campaign: { campaignId: plan.campaignId, paperId: plan.paperId, spec: plan },
    node: plan.nodes.find((node) => node.kind === 'writer'),
    workspace,
  }), /approved_proposal_seed_contract_hash_invalid/);
});
