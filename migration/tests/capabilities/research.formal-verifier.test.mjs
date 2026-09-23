import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createLakeFormalVerifier } from '../../../paper-adapters/research-verify/lake-formal-verifier.mjs';
import { leanSourceDeclarationRecords } from '../../../paper-adapters/research-verify/lean-source-contracts.mjs';
import { buildFormalClaimContract } from '../../../paper-domain/research/formal-claim-contract.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import { temporaryDirectory } from './test-support.mjs';

test('research.formal-verifier binds Lake project lock and replays certificate inputs', async (t) => {
  const root = await temporaryDirectory(t);
  const source = 'theorem fixtureTheorem : 1 = 1 := by rfl\n';
  await Promise.all([fsp.writeFile(path.join(root, 'lakefile.lean'), 'import Lake\n'), fsp.writeFile(path.join(root, 'lean-toolchain'), 'leanprover/lean4:v4.30.0\n'), fsp.writeFile(path.join(root, 'lake-manifest.json'), '{}\n'), fsp.writeFile(path.join(root, 'Main.lean'), source), fsp.writeFile(path.join(root, 'Audit.lean'), 'import Main\n')]);
  const declaration = leanSourceDeclarationRecords(source).find((item) => item.name === 'fixtureTheorem');
  const formalClaimContract = buildFormalClaimContract({
    claimId: 'claim-1', claimText: 'One equals one.', sourceLocator: 'paper.tex#claim-1',
    theoremName: 'fixtureTheorem', theoremTypeHash: declaration.typeHash, sourceStatementHash: declaration.statementHash,
    proofObligations: ['fixtureTheorem'], manuscriptSourceIdentity: { path: 'paper.tex', byteStart: 0, byteEnd: 4, contentHash: 'sha256:claim', fileHash: 'sha256:paper' }, semanticReview: {
      status: 'formal_semantic_review_verified', reviewerId: 'reviewer', authorId: 'author', semanticEquivalenceVerified: true,
      reviewReceiptHash: hashRecord('FormalSemanticReviewReceipt', { claimId: 'claim-1', theoremName: 'fixtureTheorem' }),
      reviewEnvelopeHash: 'sha256:envelope', reviewNodeId: 'review-node', reviewAttemptId: 'review-attempt', reviewAgentReceiptHash: 'sha256:review-agent', authorNodeId: 'author-node', authorAgentReceiptHash: 'sha256:author-agent', reviewedManuscriptHash: 'sha256:paper', reviewedWorkerPlanHash: 'sha256:plan',
    },
  });
  const toolchainIdentity = Object.freeze({
    status: 'lean_toolchain_identity_verified', toolchain: 'leanprover/lean4:v4.30.0',
    leanToolchainContentIdentityHash: hashRecord('FixtureToolchainIdentity', {}), blockers: [],
  });
  const verifier = createLakeFormalVerifier({ projectRoot: root, toolchainIdentityProvider: { inspect: () => toolchainIdentity }, commandRunner: { run: async (spec) => ({ ok: true, receiptHash: hashBytes(JSON.stringify(spec)), stdout: "fixtureTheorem : 1 = 1\n'fixtureTheorem' does not depend on any axioms\n", stderr: '' }) } });
  const build = await verifier.verify();
  assert.equal(build.status, 'formal_build_verified');
  const certificate = await verifier.verify({
    claimBindings: [{ claimId: 'claim-1', theoremName: 'fixtureTheorem', sourceFile: 'Main.lean', expectedTypeHash: declaration.typeHash, sourceStatementHash: declaration.statementHash, proofObligations: ['fixtureTheorem'], manuscriptClaimHash: formalClaimContract.manuscriptClaimHash, formalClaimContract, unconditional: true }],
  });
  assert.equal(certificate.status, 'formal_claim_verified');
  assert.equal((await verifier.replay({ certificateBundle: certificate })).status, 'formal_claim_replay_verified');
  assert.equal((await verifier.verify({ declarationReports: [] })).status, 'formal_verifier_blocked');
});
