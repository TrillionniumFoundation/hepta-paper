import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import {
  signAuthorityDocument,
} from '../../paper-adapters/authority/authority-signatures.mjs';
import { runPaperProposalAdapter } from '../../paper-adapters/proposal/index.mjs';
import { materializeApprovedProposal } from '../../paper-adapters/proposal/proposal-materialization.mjs';
import { verifyPaperProposalApproval } from '../../paper-adapters/proposal/proposal-approval-verification.mjs';
import {
  buildPaperProposalReviewGate,
  createPaperProductionPlanEnvelope,
  createPaperProposalApprovalDocument,
  hashPaperRecord,
} from '../../paper-domain/contracts/index.mjs';
import { parsePaperProductionArgs } from '../src/paper-production-cli-options.mjs';

const NOW = new Date('2026-07-15T10:00:00.000Z');

function temporary(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-proposal-approval-'));
  const root = path.join(parent, 'assets');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root, runtimeRoot };
}

function authorityFixture(runtimeRoot, roles = ['proposal_approver']) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'proposal-key-1',
      subjectId: 'proposal-operator-1',
      organization: 'Research Operations',
      algorithm: 'ed25519',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      roles,
      status: 'active',
    }],
  };
  fs.mkdirSync(path.join(runtimeRoot, 'trust'), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json'),
    `${JSON.stringify(trustStore, null, 2)}\n`,
  );
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    trustStore,
  };
}

function unsignedApproval(report, overrides = {}) {
  return createPaperProposalApprovalDocument({
    ideaBrief: report.ideaBrief,
    proposalEnvelope: report.proposalEnvelope,
    generationReceipt: report.generationReceipt,
    operatorIdentity: { subjectId: 'proposal-operator-1', displayName: 'Proposal Operator' },
    riskAcceptanceRationale: 'The operator accepts the exact novelty and feasibility risks bound by hash.',
    signedAt: '2026-07-15T09:00:00.000Z',
    validFrom: '2026-07-15T09:00:00.000Z',
    expiresAt: '2026-07-16T09:00:00.000Z',
    ...overrides,
  });
}

function signApproval(document, privateKeyPem, role = 'proposal_approver', keyId = 'proposal-key-1') {
  return signAuthorityDocument(document, { privateKeyPem, keyId, role });
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

function scientificClaimDocument() {
  return {
    version: 1,
    kind: 'PaperScientificClaimInput',
    claims: [{
      claimKey: 'identifiable-estimator-consistency',
      statement: 'For every identifiable model in the stated bounded class, the proposed estimator is consistent as the sample size tends to infinity.',
      assumptions: ['The model is identifiable and belongs to the stated bounded class.'],
      quantifiers: ['For every model in the stated bounded class.'],
      negativeBoundaries: ['No finite-sample rate or efficiency claim is made.'],
      proofObligations: ['Prove identification and convergence in probability under the stated assumptions.'],
    }],
  };
}

function request({ root, runtimeRoot, paperId = 'authority-proposal' } = {}) {
  return {
    root,
    runtimeRoot,
    paperId,
    idea: 'Prove an identifiable estimator theorem and validate it with a simulation benchmark.',
    discipline: 'statistics',
    venue: 'Annals of Statistics',
    paperType: 'theorem, proof, and simulation',
    scientificClaimDocument: scientificClaimDocument(),
    now: NOW,
  };
}

test('proposal materialization and staging require a trusted signed approval and persist its evidence', async (t) => {
  const fixture = temporary(t);
  const input = request(fixture);
  const draft = await runPaperProposalAdapter(input);
  const authority = authorityFixture(fixture.runtimeRoot);
  const approvalDocument = signApproval(unsignedApproval(draft), authority.privateKeyPem);
  const report = await withArtifactWriteContext(writeContext(), () => runPaperProposalAdapter({
    ...input,
    approvalDocument,
    materializeSource: true,
    stageInventory: true,
  }));

  assert.equal(report.approvalVerification.status, 'proposal_approval_verified');
  assert.equal(report.reviewGate.status, 'proposal_approved_for_production_plan');
  assert.equal(report.materialization.status, 'paper_task_draft_materialized');
  assert.equal(report.inventoryStaging.status, 'proposal_inventory_staged');
  assert.equal(
    report.reviewGate.approvalVerificationReceiptHash,
    report.approvalVerification.paperProposalApprovalVerificationReceiptHash,
  );
  assert.equal(
    report.materialization.paperTask.registry.approvalDocumentHash,
    report.approvalVerification.approvalDocumentHash,
  );
  assert.equal(
    report.inventoryStaging.stagingRecord.approvalVerificationReceiptHash,
    report.approvalVerification.paperProposalApprovalVerificationReceiptHash,
  );
  assert.ok(report.materialization.records.some((record) => record.role === 'proposal_approval_document'));
  assert.ok(report.materialization.records.some(
    (record) => record.role === 'proposal_approval_verification_receipt',
  ));
  const source = path.join(fixture.runtimeRoot, 'proposals', input.paperId, 'source');
  assert.equal(fs.existsSync(path.join(source, 'PROPOSAL_APPROVAL_DOCUMENT.json')), true);
  assert.equal(fs.existsSync(path.join(source, 'PROPOSAL_APPROVAL_VERIFICATION_RECEIPT.json')), true);
  assert.doesNotMatch(
    fs.readFileSync(path.join(fixture.runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json'), 'utf8'),
    /PRIVATE KEY/,
  );
});

test('approval binding covers venue, every claim, quality profiles, risks, operator, hashes, and time', async (t) => {
  const fixture = temporary(t);
  const input = request(fixture);
  const draft = await runPaperProposalAdapter(input);
  const authority = authorityFixture(fixture.runtimeRoot);
  const baseline = unsignedApproval(draft);
  const cases = [
    {
      blocker: 'proposal_approval_target_venue_mismatch',
      document: { ...baseline, targetVenue: 'Different Venue' },
    },
    {
      blocker: 'proposal_approval_contribution_claim_hashes_mismatch',
      document: { ...baseline, contributionClaimHashes: baseline.contributionClaimHashes.slice(1) },
    },
    {
      blocker: 'proposal_approval_quality_profiles_mismatch',
      document: { ...baseline, qualityProfiles: baseline.qualityProfiles.slice(1) },
    },
    {
      blocker: 'proposal_approval_risk_acceptance_mismatch',
      document: {
        ...baseline,
        riskAcceptance: { ...baseline.riskAcceptance, acceptedRiskHashes: baseline.riskAcceptance.acceptedRiskHashes.slice(1) },
      },
    },
    {
      blocker: 'proposal_approval_generation_receipt_hash_mismatch',
      document: { ...baseline, generationReceiptHash: `sha256:${'0'.repeat(64)}` },
    },
    {
      blocker: 'proposal_approval_operator_not_verified_signer',
      document: {
        ...baseline,
        operatorIdentity: { ...baseline.operatorIdentity, subjectId: 'different-operator' },
      },
    },
    {
      blocker: 'authority_expired',
      document: {
        ...baseline,
        signedAt: '2026-07-13T09:00:00.000Z',
        validFrom: '2026-07-13T09:00:00.000Z',
        expiresAt: '2026-07-14T09:00:00.000Z',
      },
    },
    {
      blocker: 'proposal_approval_signed_in_future',
      document: {
        ...baseline,
        signedAt: '2026-07-16T09:00:00.000Z',
        validFrom: '2026-07-16T09:00:00.000Z',
        expiresAt: '2026-07-17T09:00:00.000Z',
      },
    },
    {
      blocker: 'authority_lifetime_exceeds_policy',
      document: {
        ...baseline,
        signedAt: '2026-07-15T09:00:00.000Z',
        validFrom: '2026-07-15T09:00:00.000Z',
        expiresAt: '2026-07-30T09:00:00.000Z',
      },
    },
  ];
  for (const scenario of cases) {
    const verification = await verifyPaperProposalApproval({
      ideaBrief: draft.ideaBrief,
      proposalEnvelope: draft.proposalEnvelope,
      generationReceipt: draft.generationReceipt,
      approvalDocument: signApproval(scenario.document, authority.privateKeyPem),
      runtimeRoot: fixture.runtimeRoot,
      now: NOW,
    });
    assert.equal(verification.status, 'proposal_approval_blocked');
    assert.ok(verification.blockers.includes(scenario.blocker), scenario.blocker);
  }
});

test('missing approval, legacy approved boolean, wrong role, and forged gate fail before proposal writes', async (t) => {
  const fixture = temporary(t);
  const input = request(fixture);
  const draft = await runPaperProposalAdapter(input);
  const authority = authorityFixture(fixture.runtimeRoot);

  const legacy = await withArtifactWriteContext(writeContext(), () => runPaperProposalAdapter({
    ...input,
    approved: true,
    materializeSource: true,
  }));
  assert.equal(legacy.materialization.status, 'paper_task_draft_blocked');
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'proposals')), false);

  const wrongRoleDocument = signApproval(
    unsignedApproval(draft),
    authority.privateKeyPem,
    'independent_referee',
  );
  const wrongRole = await withArtifactWriteContext(writeContext(), () => runPaperProposalAdapter({
    ...input,
    approvalDocument: wrongRoleDocument,
    materializeSource: true,
  }));
  assert.equal(wrongRole.materialization.status, 'paper_task_draft_blocked');
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'proposals')), false);

  const forgedReceiptPayload = {
    version: 1,
    kind: 'PaperProposalApprovalVerificationReceipt',
    status: 'proposal_approval_verified',
    paperId: draft.proposalEnvelope.paperId,
    proposalEnvelopeHash: draft.proposalEnvelope.paperProposalEnvelopeHash,
    generationReceiptHash: draft.generationReceipt.paperProposalGenerationReceiptHash,
    approvalDocumentHash: `sha256:${'1'.repeat(64)}`,
    operatorIdentity: { subjectId: 'forged-operator', role: 'proposal_approver' },
  };
  const forgedReceipt = {
    ...forgedReceiptPayload,
    paperProposalApprovalVerificationReceiptHash: hashPaperRecord(
      'PaperProposalApprovalVerificationReceipt',
      forgedReceiptPayload,
    ),
  };
  const forgedGate = buildPaperProposalReviewGate({
    proposalEnvelope: draft.proposalEnvelope,
    generationReceipt: draft.generationReceipt,
    approvalVerification: forgedReceipt,
  });
  const forgedPlan = createPaperProductionPlanEnvelope({
    proposalEnvelope: draft.proposalEnvelope,
    reviewGate: forgedGate,
  });
  const forgedMaterialization = await withArtifactWriteContext(writeContext(), () => materializeApprovedProposal({
    root: fixture.root,
    runtimeRoot: fixture.runtimeRoot,
    ideaBrief: draft.ideaBrief,
    proposalEnvelope: draft.proposalEnvelope,
    generationReceipt: draft.generationReceipt,
    productionPlanEnvelope: forgedPlan,
    reviewGate: forgedGate,
    approvalDocument: null,
    now: NOW,
  }));
  assert.equal(forgedMaterialization.status, 'paper_task_draft_blocked');
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'proposals')), false);
});

test('proposal CLI rejects boolean approval and accepts only an approval document path', () => {
  assert.throws(
    () => parsePaperProductionArgs(['proposal', '--approved']),
    /proposal_boolean_approval_removed_use_approval_document/,
  );
  const parsed = parsePaperProductionArgs([
    'proposal',
    '--scientific-claim-document',
    '/tmp/claims.json',
    '--approval-document',
    '/tmp/approval.json',
  ]);
  assert.equal(parsed['scientific-claim-document'], '/tmp/claims.json');
  assert.equal(parsed['approval-document'], '/tmp/approval.json');
});
