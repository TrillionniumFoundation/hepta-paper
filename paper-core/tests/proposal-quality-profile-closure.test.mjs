import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runPaperProposalAdapter } from '../../paper-adapters/proposal/index.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { createPaperProposalApprovalDocument } from '../../paper-domain/contracts/index.mjs';

const FIXED_NOW = new Date('2026-07-15T10:00:00.000Z');

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function approvalAuthority(report) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'proposal-approver-key',
      subjectId: 'proposal-operator-1',
      algorithm: 'ed25519',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      roles: ['proposal_approver'],
      status: 'active',
    }],
  };
  const unsigned = createPaperProposalApprovalDocument({
    ideaBrief: report.ideaBrief,
    proposalEnvelope: report.proposalEnvelope,
    generationReceipt: report.generationReceipt,
    operatorIdentity: { subjectId: 'proposal-operator-1', displayName: 'Proposal Operator' },
    riskAcceptanceRationale: 'The signed operator accepts the proposal-scoped novelty and feasibility risks.',
    signedAt: '2026-07-15T09:00:00.000Z',
    validFrom: '2026-07-15T09:00:00.000Z',
    expiresAt: '2026-07-16T09:00:00.000Z',
  });
  return {
    trustStoreOverride: trustStore,
    approvalDocument: signAuthorityDocument(unsigned, {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      keyId: 'proposal-approver-key',
      role: 'proposal_approver',
    }),
  };
}

function scientificClaimDocument(statement = 'For every bounded operator satisfying the stated contraction assumption, the iterates converge to its unique fixed point.') {
  return {
    version: 1,
    kind: 'PaperScientificClaimInput',
    claims: [{
      claimKey: 'bounded-operator-convergence',
      statement,
      assumptions: ['The operator is a contraction on a complete bounded metric space.'],
      quantifiers: ['For every operator and initial point satisfying the stated assumptions.'],
      negativeBoundaries: ['No convergence claim is made for non-contractive operators.'],
      proofObligations: ['Establish existence, uniqueness, and convergence of the iterates.'],
    }],
  };
}

test('an approved mathematical idea materializes a formal profile that enters the theorem-spec chain', async (t) => {
  const parent = temporary(t, 'hepta-proposal-formal-profile-');
  const root = path.join(parent, 'assets');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(root);
  const writeContext = {
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
  const request = {
    root,
    runtimeRoot,
    idea: 'Prove a new convergence theorem for a bounded operator.',
    paperId: 'formal-proposal',
    discipline: 'mathematics',
    paperType: 'theorem and proof',
    scientificClaimDocument: scientificClaimDocument(),
    now: FIXED_NOW,
  };
  const draft = await runPaperProposalAdapter(request);
  const authority = approvalAuthority(draft);
  const report = await withArtifactWriteContext(writeContext, () => runPaperProposalAdapter({
    ...request,
    ...authority,
    materializeSource: true,
  }));

  assert.equal(report.materialization.status, 'paper_task_draft_materialized');
  assert.deepEqual(report.proposalEnvelope.proposal.recommendedPaperQualityProfiles, ['formal_theorem_or_proof']);
  assert.equal(report.materialization.paperTask.paperQualityProfile, 'formal_theorem_or_proof');
  assert.deepEqual(report.materialization.paperTask.paperQualityProfiles, ['formal_theorem_or_proof']);

  const plan = buildPaperCampaignPlan({
    paperId: report.materialization.paperTask.paperId,
    sourceWorkspace: path.resolve(root, report.materialization.paperTask.sourceWorkspace),
    campaignId: 'formal-proposal-campaign',
    mode: 'full-campaign',
    languages: ['lean', 'latex'],
    paperTask: report.materialization.paperTask,
    paperQualityProfile: report.materialization.paperTask.paperQualityProfile,
    paperQualityProfiles: report.materialization.paperTask.paperQualityProfiles,
  });
  const kinds = plan.nodes.map((node) => node.kind);
  assert.ok(kinds.includes('theorem-spec'));
  assert.ok(kinds.includes('formal-verify'));
  assert.ok(kinds.includes('research-verify'));
});

test('statistics proposals declare both formal and empirical evidence profiles before approval', async (t) => {
  const parent = temporary(t, 'hepta-proposal-statistics-profile-');
  const root = path.join(parent, 'assets');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(root);
  const report = await runPaperProposalAdapter({
    root,
    runtimeRoot,
    idea: 'Construct an identifiable estimator and validate it in a simulation benchmark.',
    paperId: 'statistics-proposal',
    discipline: 'statistics',
    now: FIXED_NOW,
    materializeSource: false,
  });

  assert.deepEqual(report.proposalEnvelope.proposal.recommendedPaperQualityProfiles, [
    'formal_theorem_or_proof',
    'empirical_or_experiment',
  ]);
  assert.equal(report.proposalEnvelope.status, 'blocked_proposal_draft');
  assert.ok(report.proposalEnvelope.blockers.includes('formal_scientific_claim_input_required'));
  assert.ok(report.productionPlanEnvelope.gatePlan.includes('paper_quality_profile_gate'));
  assert.equal(report.reviewGate.approved, false);
});

test('proposal materialization rejects direct and symlink runtime overlap before its first artifact write', async (t) => {
  const parent = temporary(t, 'hepta-proposal-runtime-overlap-');
  const assetRoot = path.join(parent, 'assets');
  fs.mkdirSync(assetRoot);
  const request = async (runtimeRoot, paperId) => {
    const input = {
      root: assetRoot,
      runtimeRoot,
      idea: 'Prove a bounded fixed-point theorem.',
      paperId,
      discipline: 'mathematics',
      paperType: 'theorem and proof',
      scientificClaimDocument: scientificClaimDocument(),
      now: FIXED_NOW,
    };
    const draft = await runPaperProposalAdapter(input);
    return runPaperProposalAdapter({
      ...input,
      ...approvalAuthority(draft),
      materializeSource: true,
    });
  };
  await assert.rejects(
    () => request(path.join(assetRoot, 'runtime'), 'direct-overlap'),
    /workspace_layout_not_physically_decoupled/,
  );
  assert.deepEqual(fs.readdirSync(assetRoot), []);

  const runtimeAlias = path.join(parent, 'runtime-alias');
  fs.symlinkSync(assetRoot, runtimeAlias, 'dir');
  await assert.rejects(
    () => request(runtimeAlias, 'symlink-overlap'),
    /workspace_layout_not_physically_decoupled/,
  );
  assert.deepEqual(fs.readdirSync(assetRoot), []);
});
