import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import { buildAutonomousResearchSeedBinding } from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import {
  proposalClaimSourceFromAuthority,
  verifyScientificClaimLineageAuthority,
} from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
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
  const machineSource = proposalClaimSourceFromAuthority(formalClaim);
  assert.equal(machineSource.claimAuthorityType, 'machine-policy-authorized');
  assert.equal(machineSource.dynamicFormalClaimSeedHash, undefined);
  for (const hashField of [
    'claimAuthorityBindingHash',
    'claimAuthorityBundleHash',
    'proposalClaimTextHash',
    'proposalClaimRecordHash',
  ]) {
    const missingHash = { ...formalClaim, [hashField]: null };
    assert.throws(
      () => proposalClaimSourceFromAuthority(missingHash),
      /proposal_claim_source_hash_invalid/,
      hashField,
    );
  }

  const proposalEnvelopeHash = hashRecord('ApprovedLineageProposal', {});
  const productionPlanEnvelopeHash = hashRecord('ApprovedLineagePlan', {});
  const reviewGateHash = hashRecord('ApprovedLineageReview', {});
  const approvedBundlePayload = {
    version: 1,
    kind: 'PaperProposalSeedContractBundle',
    status: 'proposal_seed_contracts_ready',
    paperId: 'approved-formal-lineage',
    proposalEnvelopeHash,
    productionPlanEnvelopeHash,
    reviewGateHash,
    claims: [{
      id: 'proposal:approved-lineage',
      kind: 'proposal_claim_seed',
      status: 'proposal_seed',
      text: 'Every admitted execution remains within its declared bound.',
      scientificClaimKey: 'approved-lineage-bound',
      assumptions: ['The execution is admitted.'],
      quantifiers: ['For every admitted execution.'],
      negativeBoundaries: ['No claim is made for rejected executions.'],
      proofObligations: ['Prove preservation of the declared bound.'],
    }],
  };
  const proposalSeedContractBundleHash = hashPaperRecord(
    'PaperProposalSeedContractBundle',
    approvedBundlePayload,
  );
  const approvedBundle = {
    ...approvedBundlePayload,
    paperProposalSeedContractBundleHash: proposalSeedContractBundleHash,
  };
  const approvedBindingPayload = {
    version: 1,
    kind: 'ApprovedProposalSeedBinding',
    status: 'approved_proposal_seed_bound',
    contractPath: 'APPROVED_SEED.json',
    proposalEnvelopeHash,
    productionPlanEnvelopeHash,
    reviewGateHash,
    proposalSeedContractBundleHash,
  };
  const approvedBinding = {
    ...approvedBindingPayload,
    approvedProposalSeedBindingHash: hashRecord(
      'ApprovedProposalSeedBinding',
      approvedBindingPayload,
    ),
  };
  const approvedAuthority = verifyScientificClaimLineageAuthority({
    scientificClaimAuthority: approvedBinding,
    seedContractBundle: approvedBundle,
    paperId: approvedBundle.paperId,
  });
  assert.equal(approvedAuthority.valid, true, JSON.stringify(approvedAuthority.blockers));
  const approvedSource = proposalClaimSourceFromAuthority(approvedAuthority.claims[0]);
  assert.equal(approvedSource.claimAuthorityType, 'operator-signed');
  assert.equal(approvedSource.proposalSeedContractBundleHash,
    proposalSeedContractBundleHash);

  const absentAuthority = verifyScientificClaimLineageAuthority();
  assert.equal(absentAuthority.valid, false);
  assert.equal(absentAuthority.claims.length, 0);
  assert.throws(
    () => proposalClaimSourceFromAuthority(),
    /proposal_claim_source_authority_type_invalid/,
  );

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

  const verifyMutation = ({ mutateBinding = null, mutateBundle = null,
    resealBinding = false } = {}) => {
    let binding = structuredClone(preparation.seedBinding);
    const bundle = structuredClone(preparation.seedBundle);
    mutateBinding?.(binding);
    mutateBundle?.(bundle);
    if (resealBinding) {
      delete binding.autonomousResearchSeedBindingHash;
      binding = {
        ...binding,
        autonomousResearchSeedBindingHash: hashRecord(
          'AutonomousResearchSeedBinding',
          binding,
        ),
      };
    }
    return verifyScientificClaimLineageAuthority({
      scientificClaimAuthority: binding,
      seedContractBundle: bundle,
      paperId,
    });
  };
  for (const [name, mutateBinding, resealBinding = false] of [
    ['binding version', (value) => { value.version = 2; }],
    ['binding kind', (value) => { value.kind = 'WrongSeedBinding'; }],
    ['binding status', (value) => { value.status = 'blocked'; }],
    ['binding authority', (value) => { value.claimAuthorityType = 'operator-signed'; }],
    ['binding hash missing', (value) => { delete value.autonomousResearchSeedBindingHash; }],
    ['binding hash mismatch', (value) => {
      value.autonomousResearchSeedBindingHash = hashRecord('WrongBinding', {});
    }],
    ['binding blockers', (value) => { value.blockers = ['blocked']; }, true],
  ]) {
    const blocked = verifyMutation({ mutateBinding, resealBinding });
    assert.equal(blocked.valid, false, name);
    if (name !== 'binding kind') {
      assert.ok(blocked.blockers.includes('autonomous_theorem_seed_binding_invalid'), name);
    }
  }
  for (const [name, mutateBundle] of [
    ['bundle version', (value) => { value.version = 3; }],
    ['bundle kind', (value) => { value.kind = 'WrongSeedBundle'; }],
    ['bundle status', (value) => { value.status = 'blocked'; }],
    ['bundle authority', (value) => { value.claimAuthorityType = 'operator-signed'; }],
    ['bundle hash missing', (value) => { delete value.autonomousResearchSeedContractBundleHash; }],
    ['bundle hash mismatch', (value) => {
      value.autonomousResearchSeedContractBundleHash = hashRecord('WrongBundle', {});
    }],
    ['bundle proposal', (value) => { value.proposalHash = hashRecord('WrongProposal', {}); }],
    ['bundle policy', (value) => {
      value.policyAuthorizationHash = hashRecord('WrongPolicy', {});
    }],
    ['bundle blockers', (value) => { value.blockers = ['blocked']; }],
  ]) {
    const blocked = verifyMutation({ mutateBundle });
    assert.ok(blocked.blockers.includes('autonomous_theorem_seed_bundle_invalid'), name);
  }
  for (const [name, mutateBundle, expected] of [
    ['operator approval', (value) => { value.safety.operatorApprovalClaimed = true; },
      'autonomous_theorem_seed_safety_invalid'],
    ['release attestation', (value) => {
      value.safety.externalReleaseAttestationRequired = false;
    }, 'autonomous_theorem_seed_safety_invalid'],
    ['machine equivalence', (value) => {
      value.safety.naturalLanguageToLeanEquivalenceMachineProven = true;
    }, 'autonomous_theorem_seed_safety_invalid'],
    ['formal claim missing', (value) => {
      value.claims = value.claims.filter((claim) => claim.verificationMode !== 'formal_kernel');
    }, 'autonomous_theorem_formal_claims_invalid'],
    ['unknown verification mode', (value) => {
      value.claims.find((claim) => claim.verificationMode === 'empirical_protocol')
        .verificationMode = 'unknown';
    }, 'autonomous_theorem_formal_claims_invalid'],
    ['template family', (value) => { value.protocolFamily = 'unknown-family'; },
      'autonomous_theorem_formal_template_family_invalid'],
    ['template registry', (value) => { value.formalSupportRegistryHash = hashRecord('Wrong', {}); },
      'autonomous_theorem_formal_template_lineage_invalid'],
    ['template id', (value) => { value.formalSupportTemplateId = 'wrong-template'; },
      'autonomous_theorem_formal_template_lineage_invalid'],
    ['template hash', (value) => { value.formalSupportTemplateHash = hashRecord('Wrong', {}); },
      'autonomous_theorem_formal_template_lineage_invalid'],
    ['template scope', (value) => {
      value.claims.find((claim) => claim.verificationMode === 'formal_kernel')
        .negativeBoundaries.push('Additional unsupported boundary.');
    }, 'autonomous_theorem_formal_template_lineage_invalid'],
  ]) {
    const blocked = verifyMutation({ mutateBundle });
    assert.ok(blocked.blockers.includes(expected), name);
  }

  const mutateFormalClaim = (mutate) => (bundle) => mutate(
    bundle.claims.find((claim) => claim.verificationMode === 'formal_kernel'),
  );
  for (const [name, mutateBundle, expected] of [
    ['claim kind', mutateFormalClaim((claim) => { claim.kind = 'wrong'; }),
      'autonomous_theorem_formal_claim_status_invalid:1'],
    ['claim status', mutateFormalClaim((claim) => { claim.status = 'blocked'; }),
      'autonomous_theorem_formal_claim_status_invalid:1'],
    ['claim set hash', mutateFormalClaim((claim) => {
      claim.machineProposedScientificClaimSetHash = 'invalid';
    }), 'autonomous_theorem_formal_claim_status_invalid:1'],
    ['claim empirical type', mutateFormalClaim((claim) => {
      claim.empiricalObligations = null;
    }), 'autonomous_theorem_formal_claim_status_invalid:1'],
    ['claim empirical content', mutateFormalClaim((claim) => {
      claim.empiricalObligations = ['not-formal'];
    }), 'autonomous_theorem_formal_claim_status_invalid:1'],
    ['claim id', mutateFormalClaim((claim) => { claim.id = ''; }),
      'autonomous_theorem_claim_id_invalid:1'],
    ['claim text', mutateFormalClaim((claim) => { claim.text = ''; }),
      'autonomous_theorem_claim_text_invalid:1'],
    ['claim key', mutateFormalClaim((claim) => { claim.scientificClaimKey = ''; }),
      'autonomous_theorem_scientific_claim_key_invalid:1'],
    ...['assumptions', 'quantifiers', 'negativeBoundaries', 'proofObligations'].map(
      (field) => [
        `claim ${field}`,
        mutateFormalClaim((claim) => { claim[field] = []; }),
        `autonomous_theorem_${field}_invalid:1`,
      ],
    ),
    ['claim duplicate list item', mutateFormalClaim((claim) => {
      claim.assumptions = [claim.assumptions[0], claim.assumptions[0]];
    }), 'autonomous_theorem_assumptions_invalid:1'],
    ['duplicate claim id', (bundle) => {
      const formal = bundle.claims.find((claim) => claim.verificationMode === 'formal_kernel');
      bundle.claims.push(structuredClone(formal));
    }, 'autonomous_theorem_claim_ids_duplicate'],
  ]) {
    const blocked = verifyMutation({ mutateBundle });
    assert.ok(blocked.blockers.includes(expected), name);
  }
});
