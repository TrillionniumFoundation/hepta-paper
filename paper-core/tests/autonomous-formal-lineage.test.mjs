import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import { buildAutonomousResearchSeedBinding } from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import { verifyScientificClaimLineageAuthority } from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import {
  finalizeTheoremSpecification,
  readFinalizedTheoremSpecification,
} from '../../paper-adapters/automation/theorem-specification-finalizer.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

test('machine policy authority exposes only non-circular formal_kernel claims to theorem finalization', async (t) => {
  const paperId = 'autonomous-formal-lineage';
  const campaignId = 'autonomous-formal-campaign';
  const preparation = await prepareAutonomousResearchLoop({
    paperId,
    objective: 'Evaluate a deterministic estimator under the fixed benchmark.',
    protocolFamily: 'ml_algorithm_benchmark',
    createdAt: '2026-07-15T12:00:00.000Z',
  });
  const authority = verifyScientificClaimLineageAuthority({
    scientificClaimAuthority: preparation.seedBinding,
    seedContractBundle: preparation.seedBundle,
    paperId,
  });
  assert.equal(authority.valid, true, JSON.stringify(authority.blockers));
  assert.equal(preparation.seedBundle.claims.some((claim) => claim.verificationMode === 'empirical_protocol'), true);
  assert.equal(authority.claims.length, 1);
  const formalClaim = authority.claims[0];
  assert.equal(formalClaim.proposalClaimId, preparation.seedBundle.claims
    .find((claim) => claim.verificationMode === 'formal_kernel').id);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-autonomous-formal-lineage-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, preparation.seedBinding.contractPath),
    `${JSON.stringify(preparation.seedBundle, null, 2)}\n`);
  fs.writeFileSync(path.join(workspace, 'main.tex'), [
    `\\begin{theorem}${formalClaim.proposalClaimText}\\end{theorem}`,
    '\\begin{proof}By induction on the schedule list.\\end{proof}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), JSON.stringify({
    version: 1,
    kind: 'TheoremSpecificationDraft',
    claims: [{
      claimKey: formalClaim.scientificClaimKey,
      title: 'Filter length is bounded by source length',
      statement: formalClaim.proposalClaimText,
      assumptions: formalClaim.assumptions,
      quantifiers: formalClaim.quantifiers,
      negativeBoundaries: formalClaim.negativeBoundaries,
      proofObligations: formalClaim.proofObligations,
      evidenceObligations: [],
      manuscriptIntent: 'existing',
      proposalClaimId: formalClaim.proposalClaimId,
    }],
  }));
  finalizeTheoremSpecification({
    workspace,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    scientificClaimAuthority: preparation.seedBinding,
  });
  const specification = readFinalizedTheoremSpecification({
    workspace,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    scientificClaimAuthority: preparation.seedBinding,
  });
  assert.equal(specification.claimAuthorityType, 'machine-policy-authorized');
  assert.equal(specification.claimAuthorityBindingHash,
    preparation.seedBinding.autonomousResearchSeedBindingHash);
  assert.equal(specification.approvedProposalSeedBindingHash, null);
  assert.equal(specification.proposalSeedContractBundleHash, null);
  assert.equal(specification.claims[0].proposalClaimSource.proposalClaimId, formalClaim.proposalClaimId);

  const circularPayload = structuredClone(preparation.seedBundle);
  delete circularPayload.autonomousResearchSeedContractBundleHash;
  const circularFormal = circularPayload.claims.find((claim) => claim.verificationMode === 'formal_kernel');
  circularFormal.text = 'For all acceptedCells and scheduledCells, if acceptedCells is at most scheduledCells, then the reported accepted-cell count does not exceed the scheduled-cell count.';
  circularFormal.assumptions = ['The accepted-cell count is bounded by the scheduled-cell count.'];
  const circularBundle = {
    ...circularPayload,
    autonomousResearchSeedContractBundleHash:
      hashRecord('AutonomousResearchSeedContractBundle', circularPayload),
  };
  const circularBinding = buildAutonomousResearchSeedBinding({
    seedBundle: circularBundle,
    contractPath: preparation.seedBinding.contractPath,
  });
  const circularAuthority = verifyScientificClaimLineageAuthority({
    scientificClaimAuthority: circularBinding,
    seedContractBundle: circularBundle,
    paperId,
  });
  assert.equal(circularAuthority.valid, false);
  assert.ok(circularAuthority.blockers.some((blocker) => (
    blocker.includes('autonomous_theorem_formal_claim_status_invalid')
  )));
});
